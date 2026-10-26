/** Source-derived checks for legacy Mongo effects. These do not grant projection serving readiness. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Db} from 'mongodb';
import type {WireReplayExpectations} from './wire-replay-outputs.ts';

export type WireStateMode = 'enabled' | 'disabled';
export const wireStateBarriers = Object.freeze([78, 81, 84, 87, 90, 93, 96, 99, 120]);
type Json = Record<string, any>;
export type WireStateSnapshot = Readonly<Record<string, readonly Json[]>>;
const protocolId = '@eosrio/hyperion-wire-plugin';
const maximumRows = 1000;
const stable = (value: any) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const compare = (a: Json, b: Json) => a['@protocol_key'] < b['@protocol_key'] ? -1 : a['@protocol_key'] > b['@protocol_key'] ? 1 : 0;

function collection(row: Json): string {
    assert.match(row.code, /^[a-z1-5.]{1,13}$/); assert.match(row.table, /^[a-z1-5.]{1,13}$/);
    return row.code + '-' + row.table;
}

export function wireStateContracts(expected: WireReplayExpectations) {
    const contracts: Record<string, Record<string, {auto_index: false; indices: Record<string, never>}>> = {};
    assert.ok(expected.deltas.length > 0 && expected.deltas.length <= maximumRows);
    for (const row of expected.deltas) {
        collection(row);
        (contracts[row.code] ??= {})[row.table] = {auto_index: false, indices: {}};
    }
    return structuredClone(contracts);
}

/** Apply every original physical primary/secondary change, retaining the two identity domains. */
export function expectedWireState(expected: WireReplayExpectations, through: number, mode: WireStateMode): WireStateSnapshot {
    assert.ok(Number.isInteger(through) && through >= 2 && through <= 120, 'state barrier outside retained interval');
    assert.ok(mode === 'enabled' || mode === 'disabled', 'invalid state mode');
    assert.ok(expected.deltas.length > 0 && expected.deltas.length <= maximumRows, 'source state inventory outside bound');
    const state = new Map<string, Map<string, Json>>();
    const seen = new Set<string>();
    let previousBlock = 0, previousOrdinal = -1;
    for (const row of expected.deltas) {
        const name = collection(row); if (!state.has(name)) state.set(name, new Map());
        assert.match(row.primaryKey, /^h45k1:[0-9a-f]{64}$/);
        assert.equal(typeof row.present, 'boolean');
        assert.ok(Number.isInteger(row.blockNum) && row.blockNum >= 2 && row.blockNum <= 120);
        assert.ok(Number.isInteger(row.ordinal) && row.ordinal >= 0);
        assert.ok(row.blockNum > previousBlock || (row.blockNum === previousBlock && row.ordinal > previousOrdinal), 'state source order differs');
        previousBlock = row.blockNum; previousOrdinal = row.ordinal;
        const occurrence = row.blockNum + ':' + row.ordinal;
        assert.ok(!seen.has(occurrence), 'duplicate source state occurrence'); seen.add(occurrence);
        assert.equal(row.source.chainId, expected.chainId); assert.equal(row.source.blockNum, row.blockNum);
        assert.equal(row.source.blockId, row.blockId); assert.equal(row.source.ordinal, row.ordinal);
        if (mode === 'disabled' || row.blockNum > through) continue;
        if (!row.present) {state.get(name)!.delete(row.primaryKey); continue;}
        const metadata = Object.fromEntries(Object.entries(row.metadata).filter(([key]) => key !== 'abiHex'));
        const document = {'@scope': '', '@pk': row.primaryKey, '@payer': row.payer,
            '@block_num': row.blockNum, '@block_time': row.timestamp, '@block_id': row.blockId,
            ...structuredClone(row.data), '@protocol_key': row.primaryKey,
            '@protocol': {id: protocolId, profileId: expected.profileId, logicalIdentity: row.identity,
                record: structuredClone(row.record), source: structuredClone(row.source), rawHex: row.rawHex, metadata}};
        state.get(name)!.set(row.primaryKey, document);
    }
    return Object.fromEntries([...state].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, rows]) => [name, [...rows.values()].sort(compare)]));
}

export function assertWireStateSnapshot(expected: WireReplayExpectations, through: number, mode: WireStateMode, observed: WireStateSnapshot) {
    const target = expectedWireState(expected, through, mode);
    assert.deepEqual(Object.keys(observed).sort(), Object.keys(target), 'state collection observation coverage differs');
    const normalized: Record<string, Json[]> = {};
    for (const [name, rows] of Object.entries(observed)) {
        assert.ok(Array.isArray(rows) && rows.length <= maximumRows, 'state row observation exceeds bound');
        normalized[name] = rows.map(row => {
            const {_id, ...value} = row;
            return structuredClone(value);
        }).sort(compare);
        assert.equal(new Set(normalized[name].map(row => row['@protocol_key'])).size, rows.length, 'duplicate physical state identity');
        assert.deepEqual(normalized[name], target[name], 'actual state differs at ' + through + ': ' + name);
    }
    const deleted = expected.deltas.filter(row => row.blockNum <= through && !row.present);
    return {through, mode, rows: Object.values(target).reduce((sum, rows) => sum + rows.length, 0),
        collections: Object.fromEntries(Object.entries(target).map(([name, rows]) => [name, rows.length])),
        sourceChanges: expected.deltas.filter(row => row.blockNum <= through).length,
        observedSourceTombstones: deleted.length, stateSha256: hash(stable(normalized)),
        sourceDerivedStateSha256: hash(stable(target)), servingReadinessQualified: false,
        interpretation: 'Observed legacy Mongo effects at a held original-source prefix; no initialization, canonical rollback or API readiness grant.'};
}

/** Bounded reads from the already ownership-verified disposable database; never writes or repairs it. */
export async function readWireState(db: Db, expected: WireReplayExpectations): Promise<WireStateSnapshot> {
    const target = expectedWireState(expected, 120, 'enabled');
    const result: Record<string, Json[]> = {};
    for (const name of Object.keys(target)) {
        const rows = await db.collection(name).find({}, {maxTimeMS: 5000}).limit(maximumRows + 1).toArray();
        assert.ok(rows.length <= maximumRows, 'state read truncated'); result[name] = rows;
    }
    return result;
}
