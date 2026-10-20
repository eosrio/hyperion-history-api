/** Independent source expectations for the bounded Wire worker qualification; no codec/worker imports. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {AuditedWireReplayFixture} from './wire-replay-fixture.ts';

export const wireReplayAccounts = ['wiremap', 'wiresec', 'wireproto', 'wireorder', 'wirenotify', 'wireinline', 'wireupgrade'] as const;
const protocolId = '@eosrio/hyperion-wire-plugin';
const maximumItems = 5000;
type Json = Record<string, any>;
export interface WireReplayDocument {_id: string; _index?: string; _source: Json}
export interface WireReplayPublication {operation: string; index: string; id: string; source?: Json; receiptNumber: number; itemStatus?: number; error?: unknown}
export interface WireReplayOutputDocuments {
    actions: readonly WireReplayDocument[]; blocks: readonly WireReplayDocument[];
    deltas: readonly WireReplayDocument[]; abis: readonly WireReplayDocument[];
    coordinator: Json; commits: readonly {id: string; value: Json}[]; certificate: Json;
    accountStates: Readonly<Record<string, Json>>; kvStates: Readonly<Record<string, Json>>;
}
export interface WireReplayExpectations {
    chainId: string; profileId: string; namespace?: string; sourceReceipts: number;
    blocks: readonly Json[]; actions: readonly Json[]; deltas: readonly Json[]; abis: readonly Json[];
    bindings: Readonly<Record<string, readonly Json[]>>; gaps: readonly string[];
}
export interface WireReplayReadClient {search(request: any): Promise<any>; get(request: any, options?: any): Promise<any>; [key: string]: any}

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function snapshot<T>(value: T): T {return structuredClone(value);}
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);} return value;
}
function uint(value: unknown, positive = false): string {
    if (typeof value === 'number') {assert.ok(Number.isSafeInteger(value), 'unsafe source sequence'); value = String(value);}
    assert.ok(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'noncanonical sequence');
    assert.ok(BigInt(value) >= (positive ? 1n : 0n) && BigInt(value) <= 0xffffffffffffffffn, 'sequence outside uint64'); return value;
}
function hex(value: unknown, size?: number): string {
    assert.ok(typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value) && (size === undefined || value.length === size), 'invalid source hex'); return value;
}
const object = (value: any): Json => {assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'expected object'); return value;};
function bounded<T>(values: readonly T[], label: string): readonly T[] {assert.ok(Array.isArray(values) && values.length <= maximumItems, label + ' count bound'); return values;}
function unique<T>(values: readonly T[], key: (value: T) => string, label: string): Map<string, T> {
    const result = new Map<string, T>(); for (const value of bounded(values, label)) {const id = key(value); assert.ok(!result.has(id), 'duplicate ' + label + ': ' + id); result.set(id, value);} return result;
}
function stable(value: any): string {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
/** Published protocol-ID contract: length-prefixed UTF-8, independent of the writer helper. */
function framed(parts: string[]): string {
    const result = createHash('sha256'); for (const part of parts) {const bytes = Buffer.from(part); const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); result.update(length).update(bytes);} return result.digest('hex');
}
const fieldId = (kind: 'state' | 'history', chain: string, identity: string, block?: Json) => kind === 'state'
    ? 'h45k1:' + framed(['hyperion-state-key-v1', protocolId, chain, identity])
    : 'h45h1:' + framed(['hyperion-history-document-v1', protocolId, chain, identity, block!.blockId, String(block!.blockNum), String(block!.ordinal)]);
const receipt = (value: any) => Array.isArray(value) && typeof value[0] === 'string' ? object(value[1]) : object(value);
function authorization(value: any): Json[] {
    assert.ok(Array.isArray(value)); return value.map(item => Array.isArray(item)
        ? {account: item[0], sequence: uint(item[1])} : {account: item.account, sequence: uint(item.sequence)});
}
function originalReceipt(value: any): Json {
    const row = receipt(value); return {receiver: row.receiver, global_sequence: uint(row.global_sequence, true), recv_sequence: uint(row.recv_sequence),
        auth_sequence: authorization(row.auth_sequence), code_sequence: row.code_sequence, abi_sequence: row.abi_sequence};
}
const bindingKey = (value: Json) => value.transactionId + ':' + value.actionOrdinal;
const abiKey = (value: Json) => value.block + ':' + value.account;

export function buildWireReplayExpectations(fixture: AuditedWireReplayFixture, namespace?: string): WireReplayExpectations {
    hex(fixture.chainId, 64); assert.equal(fixture.profileId, 'wire-sysio-7dede884-engineering-v1');
    if (namespace !== undefined) assert.match(namespace, /^[a-z0-9][a-z0-9_.-]{0,120}$/);
    assert.equal(fixture.replayStart, 2); assert.equal(fixture.replayEnd, 120);
    const checks = unique(snapshot(fixture.independentChecks), check => check.id, 'independent check');
    const expected = (id: string) => {const check = checks.get(id); assert.ok(check && Object.hasOwn(check, 'expected'), 'missing independent expectation: ' + id); return check.expected.result;};
    const records = unique(fixture.records, row => String(row.blockNum), 'source block');
    const sourceBlocks = unique(fixture.audit.blocks, (row: any) => String(row.blockNum), 'audit block');
    assert.equal(records.size, 119); assert.equal(sourceBlocks.size, 119);
    const blocks: Json[] = [], occurrences = new Map<string, Json>(), bindings: Record<string, Json[]> = {}, physical: Json[] = [];
    for (let number = 2; number <= 120; number++) {
        const source = object(sourceBlocks.get(String(number))), captured = records.get(String(number)); assert.ok(captured);
        assert.equal(captured.id, hex(source.blockId, 64)); assert.equal(hash(captured.frame), captured.frameSha256);
        const signed = object(expected(`block-${number}-signed`));
        assert.equal(signed.previous, captured.previousId);
        blocks.push({blockNum: number, blockId: source.blockId, previousId: captured.previousId, timestamp: signed.timestamp, producer: signed.producer});
        const inBlock: Json[] = [];
        for (const traceVariant of bounded(expected(`block-${number}-traces`), 'source trace')) {
            const trace = object((traceVariant as any)[1]);
            const members = unique(trace.action_traces.map((row: any) => object(row[1])), (row: Json) => String(row.action_ordinal), 'source occurrence');
            for (const action of members.values()) {
                let origin = action; const seen = new Set<number>();
                while (origin.receiver !== origin.act.account) {
                    assert.ok(!seen.has(origin.action_ordinal) && seen.size < 64, 'invalid notification ancestry'); seen.add(origin.action_ordinal);
                    const parent = members.get(String(origin.creator_action_ordinal)); assert.ok(parent, 'missing notification origin');
                    assert.deepEqual(parent.act, origin.act, 'notification action differs from origin'); origin = parent;
                }
                const rec = receipt(action.receipt), global = uint(rec.global_sequence, true);
                const binding = {transactionId: trace.id, actionOrdinal: action.action_ordinal, inputActionOrdinal: origin.action_ordinal,
                    receiver: action.receiver, account: action.act.account, name: action.act.name, globalSequence: global,
                    receiptAbiSequence: uint(rec.abi_sequence), rawSha256: hash(Buffer.from(hex(action.act.data), 'hex'))};
                inBlock.push(binding);
                assert.ok(!occurrences.has(global), 'duplicate source global sequence');
                occurrences.set(global, {...binding, blockNum: number, blockId: source.blockId, timestamp: signed.timestamp,
                    producer: signed.producer, action, rawHex: action.act.data, receipts: originalReceipt(rec)});
            }
        }
        bindings[String(number)] = inBlock;
        let ordinal = 0;
        for (const delta of expected(`block-${number}-deltas-compat`).deltas) for (const row of delta[1].rows) {
            physical.push({blockNum: number, blockId: source.blockId, timestamp: signed.timestamp, stream: delta[1].name,
                ordinal: ordinal++, present: row.present === 1 || row.present === true, rawHex: hex(row.data)});
        }
    }
    assert.equal(occurrences.size, fixture.audit.actionReceiptCount, 'source receipt inventory differs');
    const deployments = bounded<Json>(fixture.audit.abiDeployments, 'ABI deployment');
    const metadata = new Map<string, Json>();
    for (const deployment of deployments) {
        assert.equal(hash(Buffer.from(hex(deployment.abiHex), 'hex')), deployment.abiSha256);
        metadata.set(deployment.abiSha256, object(expected(`abi-deployment-${deployment.target}-${deployment.globalSequence}`)));
    }
    const abis: Json[] = [];
    for (const row of physical.filter(row => row.stream === 'account')) {
        const decoded = expected(`block-${row.blockNum}-row-${row.ordinal}`)[1];
        if (!(wireReplayAccounts as readonly string[]).includes(decoded.name)) continue;
        const bytes = hex(decoded.abi), digest = hash(Buffer.from(bytes, 'hex'));
        assert.ok(!bytes || metadata.has(digest), 'unobserved selected-account ABI');
        abis.push({account: decoded.name, block: row.blockNum, block_id: row.blockId, ordinal: row.ordinal,
            abi_hex: bytes, abi_available: row.present && !!bytes, abiMetadata: bytes ? metadata.get(digest) : null});
    }
    unique(abis, abiKey, 'ABI reference');
    const applications = unique<Json>(fixture.audit.applicationActions, value => uint(value.globalSequence, true), 'application action');
    const actions: Json[] = [];
    for (const source of occurrences.values()) {
        if (source.actionOrdinal !== source.inputActionOrdinal || !(wireReplayAccounts as readonly string[]).includes(source.account)) continue;
        const app = applications.get(source.globalSequence); assert.ok(app, 'selected source input absent from application audit');
        for (const key of ['blockNum', 'transactionId', 'actionOrdinal', 'inputActionOrdinal', 'account', 'name', 'rawHex']) assert.equal(app[key], source[key]);
        const members = [...occurrences.values()].filter(row => row.transactionId === source.transactionId && row.inputActionOrdinal === source.actionOrdinal)
            .sort((a, b) => BigInt(a.globalSequence) < BigInt(b.globalSequence) ? -1 : 1);
        actions.push({...source, data: snapshot(expected('action-' + source.globalSequence)), abiSha256: app.abiSha256,
            code_sequence: receipt(source.action.receipt).code_sequence, abi_sequence: receipt(source.action.receipt).abi_sequence,
            receipts: members.map(row => row.receipts), act_digest: receipt(source.action.receipt).act_digest,
            authorization: snapshot(source.action.act.authorization), creatorActionOrdinal: source.action.creator_action_ordinal,
            returnHex: hex(source.action.return_value ?? '')});
    }
    assert.equal(actions.length, applications.size, 'application audit contains non-source inputs');
    const kvAudit = unique<Json>(fixture.audit.kvEvents, row => row.blockNum + ':' + row.deltaOrdinal, 'KV event');
    const deltas: Json[] = [];
    for (const row of physical.filter(row => row.stream === 'contract_row_kv' || row.stream === 'contract_index_kv')) {
        const event = kvAudit.get(row.blockNum + ':' + row.ordinal); assert.ok(event, 'physical KV row absent from audit');
        assert.equal(event.rawHex, row.rawHex); assert.equal(event.present, row.present);
        const decoded = object(event.decoded[1]), raw = Buffer.from(row.rawHex, 'hex'); assert.ok(raw.length >= 19 && raw[0] === 0, 'unsupported KV source version');
        const isRow = row.stream === 'contract_row_kv';
        const record = {kind: row.stream, present: row.present, code: raw.readBigUInt64LE(1).toString(), payer: raw.readBigUInt64LE(9).toString(),
            tableId: decoded.table_id, ...(isRow ? {keyHex: decoded.key, valueHex: decoded.value} : {secondaryKeyHex: decoded.sec_key, primaryKeyHex: decoded.pri_key})};
        assert.equal(raw.readUInt16LE(17), decoded.table_id);
        const identity = `wire-kv-v1:${isRow ? 'row' : 'index'}:${fixture.chainId}:${record.code}:${record.tableId}:`
            + (isRow ? decoded.key : decoded.sec_key + ':' + decoded.pri_key);
        const abi = abis.filter(value => value.account === decoded.code && value.block <= row.blockNum && value.abi_available).at(-1);
        assert.ok(abi && abi.block <= row.blockNum, 'KV row lacks independently observed ABI');
        const table = abi.abiMetadata.tables.find((value: Json) => isRow ? value.table_id === decoded.table_id
            : value.secondary_indexes?.some((index: Json) => index.table_id === decoded.table_id)); assert.ok(table, 'KV numeric table absent from captured ABI');
        const secondary = isRow ? undefined : table.secondary_indexes.find((value: Json) => value.table_id === decoded.table_id);
        const source = {chainId: fixture.chainId, blockId: row.blockId, blockNum: row.blockNum, ordinal: row.ordinal,
            abiDeployment: `${abi.block_id}:${abi.account}:${hash(Buffer.from(abi.abi_hex, 'hex'))}`};
        deltas.push({...row, id: fieldId('history', fixture.chainId, identity, source), primaryKey: fieldId('state', fixture.chainId, identity),
            identity, record, source, code: decoded.code, payer: decoded.payer, table: table.name,
            data: isRow && row.present ? snapshot(expected(`kv-value-${row.blockNum}-${row.ordinal}`)) : {},
            abiSha256: hash(Buffer.from(abi.abi_hex, 'hex')), abiBlock: abi.block,
            metadata: {profileId: fixture.profileId, recordKind: isRow ? 'row' : 'index', present: row.present, code: decoded.code,
                payer: decoded.payer, rawHex: row.rawHex, primaryTableId: table.table_id, valueType: table.type,
                ...(secondary ? {secondaryName: secondary.name, secondaryKeyType: secondary.key_type} : {})}});
    }
    assert.equal(deltas.length, kvAudit.size, 'KV audit contains extra records'); unique(deltas, row => row.id, 'physical history ID');
    const duplicateBlock = actions.filter(row => row.blockNum === 108);
    assert.equal(duplicateBlock.length, 4, 'block108 must contain four distinct input groups');
    assert.equal(duplicateBlock.reduce((sum, row) => sum + row.receipts.length, 0), 6, 'block108 must retain six receipts');
    assert.deepEqual(duplicateBlock.filter(row => row.name === 'noop').map(row => row.globalSequence).sort(), ['141', '144']);
    assert.ok(actions.some(row => row.blockNum === 111 && row.account === 'wireupgrade' && row.abi_sequence === 1));
    assert.ok(actions.some(row => row.blockNum === 120 && row.account === 'wireupgrade' && row.abi_sequence === 2));
    assert.ok(abis.some(row => row.block === 117 && row.account === 'wireupgrade' && row.abi_available));
    assert.ok(actions.some(row => row.data.id === '18446744073709551615' && row.data.amount === '9007199254740993'), 'missing exact application uint64 cases');
    assert.ok(deltas.some(row => row.stream === 'contract_row_kv' && !row.present), 'source lacks primary tombstone');
    assert.ok(!deltas.some(row => row.stream === 'contract_index_kv' && !row.present), 'unexpected secondary deletion changes qualification scope');
    return freeze({chainId: fixture.chainId, profileId: fixture.profileId, ...(namespace ? {namespace} : {}), sourceReceipts: occurrences.size,
        blocks, actions, deltas, abis, bindings, gaps: [
            'Recorded primary history tombstone only; no Elasticsearch delete or dynamic-state readiness is certified.',
            'No observed secondary update/deletion, fork/reconnect, initial ABI frontier, full-width source sequence or selected-testnet qualification.',
            'contract_state remains disabled. Follow-up: deserializer.pushToDynamicTableQueue emits neither body.id/body.present nor headers.id; '
            + 'ElasticRoutes.buildDynamicTableBulk reads body.id/body.present. Enabling contract_state requires an owning reproduction/fix, not a relaxed history assertion.',
        ]});
}

function expectedPairs(actual: any, expected: string, label: string) {assert.deepEqual(actual, {value: expected, key: expected.padStart(20, '0')}, label);}
function checkAction(expected: Json, source: Json, physical: boolean) {
    assert.equal(source.global_sequence, expected.globalSequence); assert.equal(source.block_num, expected.blockNum); assert.equal(source.block_id, expected.blockId);
    assert.equal(source.trx_id, expected.transactionId); assert.equal(source.action_ordinal, expected.actionOrdinal); assert.equal(source.creator_action_ordinal, expected.creatorActionOrdinal);
    assert.equal(source['@timestamp'], expected.timestamp); assert.equal(source.producer, expected.producer);
    assert.deepEqual(source.act, {account: expected.account, name: expected.name, authorization: expected.authorization, data: expected.data});
    assert.equal(source.act_digest, expected.act_digest); assert.equal(source.abi_sequence, expected.abi_sequence); assert.equal(source.code_sequence, expected.code_sequence);
    assert.equal(source.ds_error, undefined, 'raw/incomplete action cannot satisfy decoded output');
    assert.equal(source.return_value ?? '', expected.returnHex);
    assert.deepEqual(source.receipts, expected.receipts, 'grouped receipt membership/counters differ');
    const proof = object(source.protocol); assert.equal(proof.status, undefined, 'incomplete action proof'); assert.equal(proof.schemaVersion, 1);
    assert.deepEqual(proof.source, {chainId: expected.chainId, blockNum: expected.blockNum, blockId: expected.blockId});
    assert.match(proof.selectionId, /^h45srcsel1:[0-9a-f]{64}$/);
    assert.deepEqual(proof.input, {transactionId: expected.transactionId, actionOrdinal: expected.actionOrdinal, inputActionOrdinal: expected.inputActionOrdinal,
        receiver: expected.account, account: expected.account, name: expected.name, rawHex: expected.rawHex,
        globalSequence: expected.globalSequence, receiptAbiSequence: String(expected.abi_sequence)});
    if (physical) {
        const exact = object(source.h45_sequences_v1); assert.equal(exact.version, 1); expectedPairs(exact.global, expected.globalSequence, 'physical action root');
        assert.equal(exact.receipts.length, expected.receipts.length);
        for (const [index, row] of expected.receipts.entries()) {
            const stored = exact.receipts[index]; assert.equal(stored.index, index); assert.equal(stored.receiver, row.receiver);
            expectedPairs(stored.global, row.global_sequence, 'physical receipt root'); expectedPairs(stored.receive, row.recv_sequence, 'physical receive sequence');
            assert.equal(stored.code_sequence, row.code_sequence); assert.equal(stored.abi_sequence, row.abi_sequence);
            assert.deepEqual(stored.authorization, row.auth_sequence.map((auth: Json, index: number) => ({index, account: auth.account,
                sequence: {value: auth.sequence, key: auth.sequence.padStart(20, '0')}})));
        }
        assert.equal(exact.code_sequence, expected.code_sequence); assert.equal(exact.abi_sequence, expected.abi_sequence);
    }
}
function checkDelta(expected: Json, source: Json) {
    for (const [field, value] of Object.entries({'@timestamp': expected.timestamp, block_num: expected.blockNum, block_id: expected.blockId,
        code: expected.code, scope: '', table: expected.table, primary_key: expected.primaryKey, payer: expected.payer, present: expected.present ? 1 : 0})) assert.equal(source[field], value, 'delta ' + field);
    assert.deepEqual(source.data, expected.data); assert.deepEqual(source.protocol, {id: protocolId, profileId: expected.profileId,
        logicalIdentity: expected.identity, record: expected.record, source: expected.source, rawHex: expected.rawHex, metadata: expected.metadata});
}
function checkAbi(expected: Json, source: Json) {
    for (const key of ['account', 'block', 'block_id', 'ordinal', 'abi_hex', 'abi_available']) assert.equal(source[key], expected[key], 'ABI reference ' + key);
    if (expected.abi_available) {assert.equal(source.abi_error, ''); assert.deepEqual(JSON.parse(source.abi), expected.abiMetadata);}
}
function namespaceIndex(expected: WireReplayExpectations, index: string | undefined, kind: string) {
    if (index !== undefined && expected.namespace) assert.ok(index.startsWith(expected.namespace + '-' + kind + '-'), 'unowned ' + kind + ' index');
}
function checkDocuments(expected: WireReplayExpectations, documents: WireReplayOutputDocuments) {
    const kinds: readonly [keyof Pick<WireReplayOutputDocuments, 'actions' | 'deltas' | 'abis'>, string,
        readonly Json[], (row: Json) => string, (value: Json, source: Json, physical: boolean) => void][] = [['actions', 'action', expected.actions, (row: Json) => row.globalSequence, checkAction],
        ['deltas', 'delta', expected.deltas, (row: Json) => row.id, checkDelta],
        ['abis', 'abi', expected.abis, (row: Json) => String(row.block) + row.account, checkAbi]];
    for (const [key, kind, source, id, check] of kinds) {
        const actual = unique(documents[key], row => row._id, kind + ' document'); assert.equal(actual.size, source.length, kind + ' document coverage');
        for (const value of source) {const row = actual.get(id(value)); assert.ok(row, 'missing ' + kind + ' document ' + id(value)); namespaceIndex(expected, row._index, kind);
            check({...value, chainId: expected.chainId, profileId: expected.profileId}, object(row._source), true);}
    }
    const blocks = unique(documents.blocks, row => row._id, 'block document'); assert.equal(blocks.size, expected.blocks.length, 'block coverage');
    for (const value of expected.blocks) {
        const row = blocks.get(String(value.blockNum)); assert.ok(row, 'missing block'); namespaceIndex(expected, row._index, 'block');
        for (const [key, entry] of Object.entries({block_num: value.blockNum, block_id: value.blockId, prev_id: value.previousId, '@timestamp': value.timestamp, producer: value.producer})) assert.equal(row._source[key], entry, 'block ' + key);
    }
}
export function assertWireReplayOutputDocuments(expected: WireReplayExpectations, documents: WireReplayOutputDocuments) {
    checkDocuments(expected, documents);
    const control = object(documents.coordinator), tip = expected.blocks.at(-1)!;
    assert.equal(control.chainId, expected.chainId); assert.equal(control.profile?.id, protocolId); assert.equal(control.profile?.profileId, expected.profileId);
    assert.equal(control.phase, 'following'); assert.equal(control.gap, null); assert.deepEqual(control.pending, []);
    assert.equal(control.head?.blockNum, tip.blockNum); assert.equal(control.head?.blockId, tip.blockId); assert.equal(control.head?.coverageStart, 2);
    assert.deepEqual(documents.certificate, {schemaVersion: 1, kind: 'settled-abi-head', chainId: expected.chainId, profile: control.profile,
        ownerId: control.ownerId, generation: control.generation, head: control.head});
    const commits = unique(documents.commits, row => String(row.value.source?.blockNum), 'coordinator commit'); assert.equal(commits.size, expected.blocks.length);
    let prior: string | null = null, selectedBindings = 0;
    for (const block of expected.blocks) {
        const retained = commits.get(String(block.blockNum)); assert.ok(retained); const commit = retained.value;
        assert.equal(commit.status, 'complete'); assert.equal(commit.reason, null); assert.equal(commit.previousCommitId, prior); prior = retained.id;
        assert.equal(commit.chainId, expected.chainId); assert.deepEqual(commit.profile, control.profile);
        assert.deepEqual(commit.source, {chainId: expected.chainId, blockNum: block.blockNum, blockId: block.blockId, previousBlockId: block.previousId});
        assert.match(commit.selectionId, /^h45srcsel1:[0-9a-f]{64}$/); assert.ok(commit.observationId && commit.observationDigest, 'unobserved ABI commit');
        const actual = unique<Json>(commit.bindings, bindingKey, 'coordinator binding'); const source = expected.bindings[String(block.blockNum)]; assert.equal(actual.size, source.length, 'coordinator source membership');
        for (const value of source) {const binding = actual.get(bindingKey(value)); assert.ok(binding); const {stateId, ...input} = binding; assert.deepEqual(input, value);}
        for (const action of expected.actions.filter(row => row.blockNum === block.blockNum)) {
            const binding = actual.get(bindingKey(action))!; const state = documents.accountStates[binding.stateId]; assert.ok(state, 'missing action ABI state');
            assert.equal(state.account, action.account); assert.equal(state.present, true); assert.equal(hash(Buffer.from(hex(state.abiHex), 'hex')), action.abiSha256, 'wrong historical action ABI');
            assert.deepEqual(state.protocol, control.profile); assert.equal(state.source.chainId, expected.chainId); assert.ok(state.source.blockNum <= action.blockNum);
            const output = documents.actions.find(row => row._id === action.globalSequence)!; assert.equal(output._source.protocol.selectionId, commit.selectionId); selectedBindings++;
        }
    }
    assert.equal(prior, control.head.commitId);
    for (const delta of expected.deltas) {
        const state = documents.kvStates[delta.blockNum + ':' + delta.code]; assert.ok(state, 'missing final-state KV ABI');
        assert.equal(state.account, delta.code); assert.equal(state.present, true); assert.deepEqual(state.protocol, control.profile);
        assert.equal(state.source.blockNum, delta.abiBlock); assert.equal(hash(Buffer.from(hex(state.abiHex), 'hex')), delta.abiSha256, 'wrong final-state KV ABI');
    }
    return {actions: expected.actions.length, actionReceipts: expected.actions.reduce((sum, row) => sum + row.receipts.length, 0), blocks: expected.blocks.length,
        historyDeltas: expected.deltas.length, primaryHistoryTombstones: expected.deltas.filter(row => row.stream === 'contract_row_kv' && !row.present).length,
        secondaryHistoryTombstones: 0, abiReferences: expected.abis.length, coordinatorCommits: commits.size, selectedActionBindings: selectedBindings,
        sourceBindings: expected.sourceReceipts, documentsSha256: hash(stable(documents)), expectationsSha256: hash(stable(expected)), gaps: expected.gaps};
}

export function assertWireReplayPublications(expected: WireReplayExpectations, publications: readonly WireReplayPublication[]) {
    const success = {action: new Set<string>(), delta: new Set<string>(), abi: new Set<string>(), block: new Set<string>()};
    const lookups = {action: new Map(expected.actions.map(row => [row.globalSequence, row])), delta: new Map(expected.deltas.map(row => [row.id, row])),
        abi: new Map(expected.abis.map(row => [String(row.block) + row.account, row])), block: new Map(expected.blocks.map(row => [String(row.blockNum), row]))};
    for (const publication of bounded(publications, 'publication')) {
        const kind = (['action', 'delta', 'abi', 'block'] as const).find(kind => publication.index.includes('-' + kind + '-')); if (!kind) continue;
        namespaceIndex(expected, publication.index, kind); assert.equal(publication.operation, 'index', 'history publication must retain tombstone as an indexed record');
        // Other passthrough delta/ABI domains can share these indices; only the selected contract slice is asserted here.
        const value = lookups[kind].get(publication.id);
        if (!value && kind === 'delta' && !publication.source?.protocol) continue;
        if (!value && kind === 'abi' && !(wireReplayAccounts as readonly string[]).includes(publication.source?.account)) continue;
        assert.ok(value && publication.source, 'unexpected or bodyless ' + kind + ' publication');
        assert.ok(Number.isSafeInteger(publication.receiptNumber) && publication.receiptNumber > 0); assert.ok(Number.isInteger(publication.itemStatus), 'unfinished publication receipt');
        const source = object(publication.source);
        if (kind === 'action') checkAction({...value, chainId: expected.chainId}, source, true);
        else if (kind === 'delta') checkDelta({...value, profileId: expected.profileId}, source);
        else if (kind === 'abi') checkAbi(value, source);
        else {assert.equal(source.block_num, value.blockNum); assert.equal(source.block_id, value.blockId);}
        if (publication.itemStatus! >= 200 && publication.itemStatus! < 300 && !publication.error) success[kind].add(publication.id);
    }
    for (const kind of ['action', 'delta', 'abi', 'block'] as const) assert.equal(success[kind].size, lookups[kind].size, 'successful ' + kind + ' publication coverage');
    return {attempts: publications.length, uniqueSuccessfulActions: success.action.size, uniqueSuccessfulHistoryDeltas: success.delta.size,
        uniqueSuccessfulAbiReferences: success.abi.size, uniqueSuccessfulBlocks: success.block.size, actualElasticsearchDeletesCertified: false};
}

export async function assertWireReplayOutputs(client: WireReplayReadClient, chain: string, fixture: AuditedWireReplayFixture, preference?: string) {
    const expected = buildWireReplayExpectations(fixture, chain);
    async function search(kind: string, filters: any[] = []) {
        const result = await client.search({index: `${chain}-${kind}-*`, size: maximumItems, track_total_hits: true,
            allow_partial_search_results: false, timeout: '20s', ...(preference ? {preference} : {}),
            query: {bool: {filter: [{range: {[kind === 'abi' ? 'block' : 'block_num']: {gte: 2, lte: 120}}}, ...filters]}}});
        assert.equal(result.timed_out, false, 'output search timed out'); assert.equal(result._shards.failed, 0, 'output search failed shards');
        assert.equal(result._shards.successful, result._shards.total, 'output search incomplete shards'); assert.equal(result.hits.total.relation, 'eq');
        assert.ok(result.hits.hits.length < maximumItems, 'output search exceeded bounded page'); assert.equal(result.hits.total.value, result.hits.hits.length, 'output search truncated');
        return result.hits.hits as WireReplayDocument[];
    }
    const [actions, blocks, deltas, abis] = await Promise.all([search('action'), search('block'),
        search('delta', [{terms: {code: [...wireReplayAccounts]}}]), search('abi', [{terms: {account: [...wireReplayAccounts]}}])]);
    // Real production read-only storage validates immutable bundle hashes; it is never used to generate expected content.
    const modulePath = '../../build/indexer/protocol/abi-frontier-store.js'; const {ProtocolAbiFrontierStore} = await import(modulePath);
    const preferredClient = Object.create(client); preferredClient.get = (request: any, options?: any) => client.get({...request, ...(preference ? {preference} : {})}, options);
    const store = new ProtocolAbiFrontierStore(preferredClient, chain, 0, {readOnly: true});
    const control = await store.readControl(); assert.ok(control, 'missing coordinator control'); const coordinator = control.value;
    assert.equal(coordinator.head?.blockNum, 120, 'ABI coordinator has not settled the retained prefix');
    const certificateValue = {schemaVersion: 1, kind: 'settled-abi-head', chainId: coordinator.chainId, profile: coordinator.profile,
        ownerId: coordinator.ownerId, generation: coordinator.generation, head: coordinator.head};
    const certificate = await store.readCertificate(store.certificateId(certificateValue));
    const commits: {id: string; value: Json}[] = [], accountStates: Record<string, Json> = {}, kvStates: Record<string, Json> = {};
    let id: string | null = coordinator.head.commitId;
    while (id !== null) {
        assert.ok(commits.length < expected.blocks.length, 'ABI commit ancestry exceeds retained prefix'); const value = await store.readCommit(id); commits.push({id, value}); id = value.previousCommitId;
        for (const action of expected.actions.filter(row => row.blockNum === value.source.blockNum)) {
            const binding = value.bindings.find((row: Json) => bindingKey(row) === bindingKey(action)); assert.ok(binding?.stateId, 'missing selected action ABI binding');
            accountStates[binding.stateId] ??= await store.readAccountState(binding.stateId);
        }
        for (const delta of expected.deltas.filter(row => row.blockNum === value.source.blockNum)) {
            const key = delta.blockNum + ':' + delta.code; kvStates[key] ??= await store.readAccount(value.stateRootId, delta.code);
        }
    }
    return {...assertWireReplayOutputDocuments(expected, {actions, blocks, deltas, abis, coordinator, certificate, commits, accountStates, kvStates}), preference: preference ?? null};
}
