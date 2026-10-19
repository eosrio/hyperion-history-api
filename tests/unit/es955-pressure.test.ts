import {describe, expect, it} from 'bun:test';
import {assertDurableBulkAcknowledged, assertNativePressureRejection, assertPressureCounterDelta,
    assertPressureRecovered, pressureCounters, runPressureQualification} from '../../scripts/qualification/es955-pressure.ts';

function stats(rejections = 0) {
    return {_nodes: {total: 3, successful: 3, failed: 0}, nodes: Object.fromEntries(['data-a', 'data-b', 'master'].map(id =>
        [id, {indexing_pressure: {memory: {limit_in_bytes: 1024 * 1024,
            current: {combined_coordinating_and_primary_in_bytes: 0, coordinating_in_bytes: 0,
                primary_in_bytes: 0, replica_in_bytes: 0, all_in_bytes: 0},
            total: {coordinating_rejections: id === 'data-a' ? rejections : 0, primary_rejections: 0, replica_rejections: 0}}},
        thread_pool: {write: {active: 0, queue: 0, rejected: 0}, write_coordination: {active: 0, queue: 0, rejected: 0}}}]))};
}
const index = 'hyp-es955-abcdef123456-pressure';
const pressureError = {type: 'es_rejected_execution_exception', reason: 'rejected execution of coordinating operation ' +
    '[coordinating_and_primary_bytes=0, replica_bytes=0, coordinating_operation_bytes=2100000, max_coordinating_bytes=1048576]'};
function item(id: string, result = 'created') {
    return {index: {_index: index, _id: id, status: result === 'created' ? 201 : 200, result,
        _shards: {total: 2, successful: 2, failed: 0}, _seq_no: 1, _primary_term: 1}};
}
function copy<T>(value: T): T { return structuredClone(value); }

describe('Elasticsearch replica bulk-pressure evidence', () => {
    it('requires an ordered acknowledgement of every item by both expected shard copies', () => {
        const expected = [{index, id: 'one'}, {index, id: 'two'}];
        const response = {errors: false, items: [item('one'), item('two', 'updated')]};
        expect(() => assertDurableBulkAcknowledged(response, expected)).not.toThrow();
        for (const changed of [{...response, errors: true}, {...response, items: response.items.slice(0, 1)},
            {...response, items: [...response.items].reverse()}, {...response, items: [item('one'), item('one')]},
            {...response, items: [{create: item('one').index}, item('two')]}, {...response, items: []}]) {
            expect(() => assertDurableBulkAcknowledged(changed, expected)).toThrow();
        }
        for (const changed of [{status: 429}, {status: 202}, {result: 'noop'}, {error: pressureError}, {_index: 'another-index'},
            {_seq_no: undefined}, {_seq_no: -1}, {_primary_term: 0}, {_primary_term: NaN},
            {_shards: undefined}, {_shards: {total: 2, successful: 1, failed: 0}},
            {_shards: {total: 2, successful: 1, failed: 1}}, {_shards: {total: 1, successful: 1, failed: 0}},
            {_shards: {total: 2, successful: 2, failed: 0, failures: [{}]}},
            {_shards: {total: 2, successful: 2, failed: 0, failures: {}}}]) {
            expect(() => assertDurableBulkAcknowledged({errors: false, items: [{index: {...item('one').index, ...changed}}]},
                [{index, id: 'one'}])).toThrow();
        }
        expect(() => assertDurableBulkAcknowledged({errors: false, items: []}, [])).toThrow();
        expect(() => assertDurableBulkAcknowledged({errors: false, items: Array(1)}, [{index, id: 'one'}])).toThrow();
        expect(() => assertDurableBulkAcknowledged(response, [{index, id: 'one'}, {index, id: 'one'}])).toThrow();
    });
    it('rejects generic 429s, circuit breakers, write queues, and pressure-like strings without native byte accounting', () => {
        expect(assertNativePressureRejection(pressureError, 429)).toBe('coordinating');
        expect(assertNativePressureRejection({type: pressureError.type,
            reason: 'rejected execution of replica operation [replica_bytes=0, replica_operation_bytes=2000000, max_replica_bytes=1572864]'}, 429))
            .toBe('replica');
        for (const error of [{...pressureError, type: 'circuit_breaking_exception'},
            {...pressureError, reason: 'rejected execution of task on EsThreadPoolExecutor[write, queue capacity = 1]'},
            {...pressureError, reason: 'rejected execution of coordinating operation [queue full]'},
            {reason: pressureError.reason}, {type: pressureError.type}, {}]) {
            expect(() => assertNativePressureRejection(error, 429)).toThrow();
        }
        expect(() => assertNativePressureRejection(pressureError, 503)).toThrow();
    });
    it('requires complete stable node measurements and a counter delta matching the observed rejection stage', () => {
        const before = stats(); const after = stats(1);
        expect(() => assertPressureCounterDelta(before, after, ['coordinating'])).not.toThrow();
        expect(() => assertPressureCounterDelta(before, before, ['coordinating'])).toThrow();
        expect(() => assertPressureCounterDelta(before, after, ['primary'])).toThrow();
        expect(() => assertPressureCounterDelta(before, after, [])).toThrow();
        expect(() => assertPressureCounterDelta(after, before, ['coordinating'])).toThrow();
        const queued = stats(); queued.nodes['data-a'].thread_pool.write.rejected = 100;
        expect(() => assertPressureCounterDelta(before, queued, ['coordinating'])).toThrow();
        const changed = stats(1); changed.nodes['replacement'] = changed.nodes['data-a']; delete changed.nodes['data-a'];
        expect(() => assertPressureCounterDelta(before, changed, ['coordinating'])).toThrow();
        for (const value of [undefined, NaN, Infinity, -1, '0']) {
            const bad = copy(after); (bad.nodes['data-a'].indexing_pressure.memory.total as any).coordinating_rejections = value;
            expect(() => pressureCounters(bad)).toThrow();
        }
        for (const changed of [{...after, _nodes: {total: 3, successful: 2, failed: 1}}, {...after, nodes: {}},
            {...after, _nodes: {total: 2, successful: 2, failed: 0}}]) {
            expect(() => pressureCounters(changed)).toThrow();
        }
        const production = stats(); production.nodes['master'].indexing_pressure.memory.limit_in_bytes = 100 * 1024 * 1024;
        expect(() => pressureCounters(production)).toThrow();
    });
    it('cannot call recovery complete while native accounting, write work, or queues remain', () => {
        expect(() => assertPressureRecovered(stats(), stats(1))).not.toThrow();
        for (const field of ['combined_coordinating_and_primary_in_bytes', 'coordinating_in_bytes',
            'primary_in_bytes', 'replica_in_bytes', 'all_in_bytes']) {
            const after = stats(1); (after.nodes['data-a'].indexing_pressure.memory.current as any)[field] = 1;
            expect(() => assertPressureRecovered(stats(), after)).toThrow();
        }
        for (const pool of ['write', 'write_coordination']) for (const field of ['active', 'queue']) {
            const after = stats(1); (after.nodes['data-a'].thread_pool as any)[pool][field] = 1;
            expect(() => assertPressureRecovered(stats(), after)).toThrow();
        }
    });
    it('retries exact unknown-outcome IDs and byte-identical sources after a top-level pressure error', async () => {
        const submitted = new Map<string, string>(); const counts = new Map<string, number>();
        let calls = 0; let snapshots = 0; let ownershipChecks = 0;
        const result = await runPressureQualification({index, owner: 'unit-owner-token',
            assertOwned: async () => { ownershipChecks++; }, snapshot: async () => stats(snapshots++ ? 1 : 0),
            client: {indices: {getSettings: async () => ({[index]: {settings: {
                'index.number_of_replicas': '1', 'index.translog.durability': 'request'}}})},
            bulk: async (request: any, options: any) => {
                calls++;
                expect(request.wait_for_active_shards).toBe('all'); expect(options.maxRetries).toBe(0);
                expect(options.requestTimeout).toBe(15_000); expect(options.opaqueId).toBe(`unit-owner-token:pressure:${calls}`);
                const ids: string[] = [];
                for (let i = 0; i < request.operations.length; i += 2) {
                    const id = request.operations[i].index._id; const source = JSON.stringify(request.operations[i + 1]);
                    if (submitted.has(id)) expect(source).toBe(submitted.get(id)); else submitted.set(id, source);
                    counts.set(id, (counts.get(id) ?? 0) + 1); ids.push(id);
                }
                if (calls === 1) throw {meta: {statusCode: 429, body: {error: pressureError}, headers: {}}};
                expect(ids.length).toBeLessThanOrEqual(8);
                // A top-level 429 may hide partial writes. Updated receipts are valid replay acknowledgements.
                return {body: {errors: false, items: ids.map(id => item(id, 'updated'))}, statusCode: 200, headers: {}};
            }}});
        expect(result.expectedDocs.length).toBe(640); expect(result.acknowledgedIds.length).toBe(640);
        expect(result.rejectedIds.length).toBe(640); expect(result.receipts.length).toBe(81);
        expect([...counts.values()].every(value => value === 2)).toBe(true);
        expect(ownershipChecks).toBe(82); expect(result.recoverySamples.length).toBe(3);
        expect(result.totalRequestBytes).toBeLessThan(8 * 1024 * 1024);
    });
    it('retries only failed items after a partial bulk, preserving all success receipts', async () => {
        const attempts: string[][] = []; let snapshotCount = 0;
        const result = await runPressureQualification({index, owner: 'unit-owner-token', assertOwned: async () => {},
            snapshot: async () => stats(snapshotCount++ ? 1 : 0),
            client: {indices: {getSettings: async () => ({[index]: {settings: {
                'index.number_of_replicas': '1', 'index.translog.durability': 'request'}}})},
            bulk: async ({operations}: any) => {
                const ids = operations.filter((_: any, i: number) => i % 2 === 0).map((op: any) => op.index._id);
                attempts.push(ids);
                const items = ids.map((id: string, i: number) => attempts.length === 1 && i >= 3
                    ? {index: {_index: index, _id: id, status: 429, error: pressureError}} : item(id));
                return {body: {errors: attempts.length === 1, items}, statusCode: 200, headers: {}};
            }}});
        const retryIds = attempts.slice(1).flat();
        expect(retryIds.length).toBe(637); expect(new Set(retryIds).size).toBe(637);
        for (const accepted of attempts[0].slice(0, 3)) expect(retryIds).not.toContain(accepted);
        expect(result.acknowledgedIds.length).toBe(640);
    });
    it('refuses async durability before sending pressure work', async () => {
        let bulkCalls = 0;
        await expect(runPressureQualification({index, owner: 'unit-owner-token', assertOwned: async () => {}, snapshot: async () => stats(),
            client: {indices: {getSettings: async () => ({[index]: {settings: {
                'index.number_of_replicas': '1', 'index.translog.durability': 'async'}}})}, bulk: async () => { bulkCalls++; }}}))
            .rejects.toThrow('request durability');
        expect(bulkCalls).toBe(0);
    });
    it('cannot count a pressure-looking exception as exercised without matching native counters', async () => {
        let bulkCalls = 0;
        await expect(runPressureQualification({index, owner: 'unit-owner-token', assertOwned: async () => {}, snapshot: async () => stats(),
            client: {indices: {getSettings: async () => ({[index]: {settings: {
                'index.number_of_replicas': '1', 'index.translog.durability': 'request'}}})},
            bulk: async () => { bulkCalls++; throw {meta: {statusCode: 429, body: {error: pressureError}}}; }}}))
            .rejects.toThrow('no matching native coordinating pressure-counter delta');
        expect(bulkCalls).toBe(1);
    });
});
