import {describe, expect, test} from 'bun:test';
import {assertWireStateSnapshot, expectedWireState, readWireState, wireStateContracts} from '../../scripts/qualification/wire-state-outputs.ts';
import type {WireReplayExpectations} from '../../scripts/qualification/wire-replay-outputs.ts';
import {parseWireWorkerReplayArguments, wireWorkerConfig} from '../../scripts/qualification/wire-worker-replay.ts';

const chainId = 'c'.repeat(64), blockId = (n: number) => n.toString(16).padStart(64, '0');
function row(blockNum: number, key: number, data: any, present = true, table = 'geodata', ordinal = 0) {
    const primaryKey = 'h45k1:' + key.toString(16).padStart(64, '0');
    return {blockNum, blockId: blockId(blockNum), ordinal, present, code: 'wiremap', table, primaryKey, data,
        timestamp: '2026-10-20T09:00:00.000', payer: 'wiremap', identity: 'full-source-key-' + key,
        record: {kind: 'contract_row_kv', keyHex: '00', present}, rawHex: '01',
        source: {chainId, blockNum, blockId: blockId(blockNum), ordinal, abiDeployment: 'observed-abi'},
        metadata: {recordKind: 'row', present, abiHex: 'excluded duplicate ABI bytes'}};
}
function input(): WireReplayExpectations {
    return {chainId, profileId: 'wire-sysio-7dede884-engineering-v1', deltas: [row(78, 1, {payload: 'v1', amount: '10'}),
        row(81, 1, {payload: 'v2', amount: '11'}), row(84, 2, {payload: 'other', amount: '12'}), row(87, 1, {}, false),
        row(90, 3, {payload: 'exact', amount: '9007199254740993'}), row(93, 2, {original_key: '-100'}, true, 'signeddata')]} as WireReplayExpectations;
}
describe('source-derived Wire Mongo effect guards (constructed records)', () => {
    test('checks insert, update, actual absence after deletion, table isolation and exact string values', () => {
        const source = input();
        const first = expectedWireState(source, 78, 'enabled');
        expect(first['wiremap-geodata']).toHaveLength(1); expect(first['wiremap-geodata'][0].payload).toBe('v1');
        const updated = expectedWireState(source, 81, 'enabled');
        expect(updated['wiremap-geodata']).toHaveLength(1); expect(updated['wiremap-geodata'][0].payload).toBe('v2');
        expect(expectedWireState(source, 84, 'enabled')['wiremap-geodata']).toHaveLength(2);
        const deleted = expectedWireState(source, 87, 'enabled');
        expect(deleted['wiremap-geodata'].map(value => value['@protocol_key'])).toEqual([source.deltas[2].primaryKey]);
        const final = expectedWireState(source, 120, 'enabled');
        expect(final['wiremap-signeddata']).toHaveLength(1);
        expect(final['wiremap-geodata'].find(value => value.payload === 'exact')!.amount).toBe('9007199254740993');
        expect(final['wiremap-geodata'][0]['@protocol'].metadata).not.toHaveProperty('abiHex');
        expect(assertWireStateSnapshot(source, 120, 'enabled', final)).toMatchObject({rows: 3, observedSourceTombstones: 1, servingReadinessQualified: false});
    });
    test('disabled mode requires empty state even with the same configured source tables', () => {
        const source = input(), observed = expectedWireState(source, 120, 'disabled');
        expect(Object.values(observed).flat()).toHaveLength(0);
        expect(assertWireStateSnapshot(source, 120, 'disabled', observed).rows).toBe(0);
        expect(() => assertWireStateSnapshot(source, 120, 'disabled', expectedWireState(source, 120, 'enabled'))).toThrow('actual state differs');
    });
    test.each(['changed-value', 'numeric-value', 'stale-update', 'undeleted-row', 'missing-row', 'wrong-source', 'duplicate', 'extra-field', 'missing-collection'])(
        'rejects %s rather than inferring write or deletion success', failure => {
            const source = input(), actual = structuredClone(expectedWireState(source, 120, 'enabled')) as Record<string, any[]>;
            const values = actual['wiremap-geodata'];
            if (failure === 'changed-value') values[0].payload = 'corrupt';
            if (failure === 'numeric-value') values.find(value => value.payload === 'exact')!.amount = 9007199254740992;
            if (failure === 'stale-update') values.push(expectedWireState(source, 78, 'enabled')['wiremap-geodata'][0]);
            if (failure === 'undeleted-row') values.push(expectedWireState(source, 81, 'enabled')['wiremap-geodata'][0]);
            if (failure === 'missing-row') values.pop();
            if (failure === 'wrong-source') values[0]['@protocol'].source.blockId = 'd'.repeat(64);
            if (failure === 'duplicate') values.push(structuredClone(values[0]));
            if (failure === 'extra-field') values[0].hidden = true;
            if (failure === 'missing-collection') delete actual['wiremap-signeddata'];
            expect(() => assertWireStateSnapshot(source, 120, 'enabled', actual)).toThrow();
        });
    test('normalizes document order and ignores only Mongo object IDs', () => {
        const source = input(), actual = structuredClone(expectedWireState(source, 120, 'enabled')) as Record<string, any[]>;
        for (const rows of Object.values(actual)) {rows.reverse(); for (const value of rows) value._id = 'owned-db-id';}
        expect(assertWireStateSnapshot(source, 120, 'enabled', actual).stateSha256).toBe(assertWireStateSnapshot(source, 120, 'enabled', expectedWireState(source, 120, 'enabled')).stateSha256);
    });
    test('refuses invalid source positions, order and barrier bounds', () => {
        for (const through of [0, 1, 121, NaN, 2.5]) expect(() => expectedWireState(input(), through, 'enabled')).toThrow();
        const unordered = input(); (unordered.deltas as any[]).reverse(); expect(() => expectedWireState(unordered, 120, 'enabled')).toThrow('source order');
        const wrong = input(); wrong.deltas[0].source.blockId = 'd'.repeat(64); expect(() => expectedWireState(wrong, 120, 'enabled')).toThrow();
    });
    test('native Mongo reads are bounded and cannot silently truncate a collection', async () => {
        const calls: any[] = [], db = {collection(name: string) {return {find(query: any, options: any) {calls.push({name, query, options});
            return {limit(limit: number) {calls.at(-1).limit = limit; return {toArray: async () => []};}};}};}};
        const observed = await readWireState(db as any, input()); expect(Object.keys(observed)).toHaveLength(2);
        expect(calls.every(call => call.limit === 1001 && call.options.maxTimeMS === 5000)).toBe(true);
        const overflow = {collection() {return {find() {return {limit() {return {toArray: async () => Array(1001).fill({})};}};}};}};
        await expect(readWireState(overflow as any, input())).rejects.toThrow('truncated');
    });
    test('explicit CLI modes configure identical table scopes with no current ABI RPC indexing', () => {
        for (const mode of ['enabled', 'disabled'] as const) {
            expect(parseWireWorkerReplayArguments(['state', 'out', '--contract-state', mode])).toMatchObject({stateMode: mode});
            const config = wireWorkerConfig('hyp-wire-012345abcdef', mode, input());
            expect(config.features.contract_state).toEqual({enabled: mode === 'enabled', contracts: wireStateContracts(input())});
            expect(config.features.contract_state.contracts['wiremap']['geodata'].auto_index).toBe(false);
        }
        expect(parseWireWorkerReplayArguments(['state', 'out', '--package-root', 'installed', '--contract-state', 'enabled']).stateMode).toBe('enabled');
        for (const args of [['state', 'out', '--contract-state', 'true'], ['state', 'out', '--contract-state', 'enabled', '--contract-state', 'disabled'],
            ['state', 'out', '--package-root', 'one', '--package-root', 'two']]) expect(() => parseWireWorkerReplayArguments(args)).toThrow();
        expect(() => wireWorkerConfig('hyp-wire-012345abcdef', 'enabled')).toThrow('together');
    });
});
