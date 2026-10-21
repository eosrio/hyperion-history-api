/** Independent physical-row/official-clio oracle, never derived from runtime or database output. */
import assert from 'node:assert/strict';
import {projectionRowKey, type ProjectionDefinition, type ProjectionField} from '@eosrio/hyperion-sdk/projection';
import {createWireShipCodec, decodeWireAbi, resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';
import {portableSourceHash, portableWorkerSourceFrame, type PortableWorkerSource} from './portable-state-worker-source.ts';
import type {PortableWorkerBarrier, PortableWorkerPlan} from './portable-state-worker.ts';

/** Source-pinned v0 physical row layout: variant,u64 code,u64 payer,u16 table,bytes key,bytes value. */
export function independentWirePrimaryRow(hex: string) {
    assert.match(hex, /^(?:[0-9a-f]{2})+$/); const bytes = Buffer.from(hex, 'hex'); assert.ok(bytes.length >= 21);
    assert.equal(bytes[0], 0); const contract = bytes.readBigUInt64LE(1).toString(), tableId = bytes.readUInt16LE(17); let offset = 19;
    const take = () => {
        let count = 0, shift = 0, terminated = false;
        for (let index = 0; index < 5; index++) {
            assert.ok(offset < bytes.length); const byte = bytes[offset++]; assert.ok(index < 4 || byte <= 15);
            count += (byte & 127) * 2 ** shift;
            if (!(byte & 128)) {assert.ok(index === 0 || byte !== 0); terminated = true; break;} shift += 7;
        }
        assert.ok(terminated && count <= 8 * 1024 * 1024 && offset + count <= bytes.length);
        const value = bytes.subarray(offset, offset + count); offset += count; return value;
    };
    const key = take(), value = take(); assert.equal(offset, bytes.length);
    return {contract, tableId, primaryKeyHex: key.toString('hex'), valueHex: value.toString('hex')};
}

function rawName(name: string) {
    const alphabet = '.12345abcdefghijklmnopqrstuvwxyz'; assert.ok(name.length > 0 && name.length <= 13);
    let value = 0n; for (let index = 0; index < 13; index++) {
        const code = index < name.length ? alphabet.indexOf(name[index]) : 0; assert.ok(code >= 0 && (index < 12 || code <= 15));
        value = value << BigInt(index < 12 ? 5 : 4) | BigInt(code);
    } return value.toString();
}
function mappedValue(value: any, fields: readonly ProjectionField[]) {
    const result: Record<string, string | number | boolean | null> = {};
    for (const field of fields) {
        let scalar = value; for (const key of field.path) {assert.ok(scalar && Object.hasOwn(scalar, key)); scalar = scalar[key];}
        // Official clio emits small uint64 values as JSON numbers; the Wire portable codec uses strings.
        // Refuse an unsafe numeric token instead of allowing JSON.parse rounding into an oracle.
        if (field.type === 'string' && typeof scalar === 'number') {assert.ok(Number.isSafeInteger(scalar)); scalar = String(scalar);}
        assert.ok(field.type === 'null' ? scalar === null : field.type === 'integer' ? Number.isSafeInteger(scalar) : typeof scalar === field.type);
        result[field.name] = scalar;
    } return result;
}

export interface PortableOracleTable {readonly table: string; readonly tableId: number; readonly fields: readonly ProjectionField[]}

/** Bind every selected source row to exact clio input/output and the original deployment bytes. */
export function derivePortableWorkerExpectations(source: PortableWorkerSource, oracle: any,
    contract: string, tables: readonly PortableOracleTable[]): {definitions: ProjectionDefinition[]; barriers: PortableWorkerBarrier[]} {
    assert.equal(oracle.schemaVersion, 1); assert.equal(oracle.success, true); assert.equal(oracle.abiJsonHashVerified, true);
    assert.match(oracle.clioSha256, /^[0-9a-f]{64}$/); assert.ok(Array.isArray(oracle.rows) && oracle.rows.length > 0 && oracle.rows.length <= 256);
    const pinned = oracle.sourceAbi; assert.ok(pinned.blockNum >= 1 && pinned.blockNum <= source.endBlock);
    assert.equal(source.records[pinned.blockNum - 1].blockId, pinned.blockId);
    assert.equal(portableSourceHash(Buffer.from(pinned.abiHex, 'hex')), pinned.abiSha256);
    const codec = createWireShipCodec(JSON.parse(source.schemaJson), resolveCodecProfile(source.profileId));
    const deployment = codec.decodeBundle(portableWorkerSourceFrame(source, pinned.blockNum));
    const accountRows = deployment.deltaRows!.filter(row => row.stream === 'account').map(row => (row.value as any)[1]);
    assert.equal(accountRows.filter(row => row.name === contract && row.abi === pinned.abiHex).length, 1,
        'oracle ABI must be the exact raw deployment from the original block');
    const abi = decodeWireAbi(Buffer.from(pinned.abiHex, 'hex'), resolveCodecProfile(source.profileId));
    const definitions = tables.map(table => {
        const declared = abi.tables!.find(item => item.name === table.table); assert.ok(declared); assert.equal(declared.table_id, table.tableId);
        const definition = {schemaVersion: 1 as const, id: `${contract.replaceAll('.', '-')}-${table.table}`, source: {
            contract, table: table.table, abiDeployment: `${pinned.blockId}:${contract}:${pinned.abiSha256}`, abiSha256: pinned.abiSha256},
        fields: structuredClone(table.fields), initialization: {kind: 'genesis' as const}};
        return {...definition, mappingRevision: portableSourceHash(JSON.stringify(definition))};
    });
    const rawContract = rawName(contract), changes: {blockNum: number; definition: ProjectionDefinition; key: string; present: boolean; value: any}[] = [];
    const seen = new Set<string>();
    for (const block of source.records) for (const row of block.applicationRows) {
        if (row.stream !== 'contract_row_kv') continue;
        const physical = independentWirePrimaryRow(row.rawHex); if (physical.contract !== rawContract) continue;
        const table = tables.find(table => table.tableId === physical.tableId); if (!table) continue;
        const definition = definitions.find(definition => definition.source.table === table.table)!;
        const physicalSha256 = portableSourceHash(Buffer.from(row.rawHex, 'hex')), valueSha256 = portableSourceHash(Buffer.from(physical.valueHex, 'hex'));
        const matches = oracle.rows.filter((entry: any) => entry.blockNum === block.blockNum && entry.physicalSha256 === physicalSha256 && entry.present === Boolean(row.present));
        assert.equal(matches.length, 1, 'each selected physical row requires exactly one independently retained oracle'); const expected = matches[0];
        assert.equal(expected.tableId, physical.tableId); assert.equal(expected.primaryKeyHex, physical.primaryKeyHex); assert.equal(expected.valueSha256, valueSha256);
        const metadata = abi.tables!.find(item => item.name === table.table)!; assert.equal(expected.type, metadata.type);
        const conversions = oracle.conversions.filter((item: any) => item.arguments[0] === 'unpack_hex' &&
            item.arguments[1] === physical.valueHex && item.arguments[item.arguments.indexOf('--type') + 1] === expected.type);
        assert.ok(conversions.length >= 1); for (const conversion of conversions) {
            assert.equal(conversion.exitCode, 0); assert.equal(conversion.stderr, ''); assert.deepEqual(JSON.parse(conversion.stdout), expected.decoded);
        }
        const occurrence = `${block.blockNum}:${row.ordinal}`; assert.ok(!seen.has(occurrence)); seen.add(occurrence);
        const identity = `wire-kv-v1:row:${source.chainId}:${rawContract}:${physical.tableId}:${physical.primaryKeyHex}`;
        changes.push({blockNum: block.blockNum, definition, key: projectionRowKey('', identity), present: Boolean(row.present), value: mappedValue(expected.decoded, definition.fields)});
    }
    assert.equal(changes.length, oracle.rows.length, 'the independent oracle inventory must match all selected original rows');
    const heights = [...new Set([...changes.map(change => change.blockNum), source.endBlock])].sort((a, b) => a - b);
    const states = new Map(definitions.map(definition => [definition.id, new Map<string, any>()]));
    const barriers = heights.map(through => {
        for (const change of changes.filter(change => change.blockNum === through)) {
            const state = states.get(change.definition.id)!; if (change.present) state.set(change.key, change.value); else state.delete(change.key);
        }
        return {through, rows: Object.fromEntries([...states].map(([id, state]) => [id, [...state].map(([key, value]) => ({key, value}))
            .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))]))};
    });
    return {definitions, barriers};
}

export function assertPortableWorkerOracle(source: PortableWorkerSource, plan: PortableWorkerPlan, oracle: any) {
    assert.equal(new Set(plan.definitions.map(definition => definition.source.contract)).size, 1);
    const abi = decodeWireAbi(Buffer.from(oracle.sourceAbi.abiHex, 'hex'), resolveCodecProfile(source.profileId));
    const tables = plan.definitions.map(definition => {const table = abi.tables!.find(table => table.name === definition.source.table); assert.ok(table);
        return {table: definition.source.table, tableId: table.table_id!, fields: definition.fields};});
    const derived = derivePortableWorkerExpectations(source, oracle, plan.definitions[0].source.contract, tables);
    assert.deepEqual(plan.definitions, derived.definitions, 'operator definitions differ from the retained original ABI/oracle mapping');
    assert.deepEqual(plan.barriers, derived.barriers, 'expected prefixes differ from the independent clio/source oracle');
}
