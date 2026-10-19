import {describe, expect, it} from 'bun:test';
import {assertCancelled, assertCompleteTasks, assertFailedShard, assertRecovered, assertTimedOut, parseFailureOptions, recoveryCounters} from '../../scripts/qualification/es955-failures.ts';

describe('Elasticsearch fault qualification evidence', () => {
    it('requires timeout metadata instead of counting an ordinary empty result as a timeout', () => {
        const result = {timed_out: true, _shards: {total: 4, failed: 0}};
        expect(() => assertTimedOut(result)).not.toThrow();
        expect(() => assertTimedOut({...result, timed_out: false})).toThrow();
        expect(() => assertTimedOut({...result, _shards: {total: 4, failed: 1}})).toThrow();
        expect(() => assertTimedOut({...result, _shards: {total: 1, failed: 0}})).toThrow();
    });
    it('requires the injected failure and surviving shards, rather than any partial response', () => {
        const result = {timed_out: false, _shards: {failed: 1, successful: 3,
            failures: [{reason: {reason: 'injected qualification shard failure: hyp-es955-12345678'}}]}};
        expect(() => assertFailedShard(result)).not.toThrow();
        for (const changed of [{...result, timed_out: true}, {...result, _shards: {...result._shards, failed: 0}},
            {...result, _shards: {...result._shards, failures: [{reason: 'unrelated mapping error'}]}},
            {...result, _shards: {...result._shards, successful: 0}}]) {
            expect(() => assertFailedShard(changed)).toThrow();
        }
    });
    it('fails recovery on retained work/accounting even when the heap is smaller', () => {
        const idle = {requestBytes: 0, requestTrips: 0, openContexts: 0, queryCurrent: 0, fetchCurrent: 0, heapBytes: 500};
        expect(() => assertRecovered({node: idle}, {node: {...idle, heapBytes: 1000}})).not.toThrow();
        for (const changed of [{requestBytes: 1}, {requestTrips: 1}, {openContexts: 1}, {queryCurrent: 1}, {fetchCurrent: 1}]) {
            expect(() => assertRecovered({node: idle}, {node: {...idle, heapBytes: 1, ...changed}})).toThrow();
        }
        expect(() => assertRecovered({node: idle}, {replacement: idle})).toThrow();
    });
    it('cannot establish recovery from missing or failed measurement nodes', () => {
        expect(() => recoveryCounters({_nodes: {total: 1, successful: 0, failed: 1}, nodes: {}})).toThrow();
        expect(() => recoveryCounters({_nodes: {total: 0, successful: 0, failed: 0}, nodes: {}})).toThrow();
        expect(() => assertRecovered({}, {})).toThrow();
        const idle = {requestBytes: 0, requestTrips: 0, openContexts: 0, queryCurrent: 0, fetchCurrent: 0, heapBytes: 1};
        for (const value of [undefined, NaN, Infinity, -1]) {
            expect(() => assertRecovered({node: idle}, {node: {...idle, requestBytes: value}})).toThrow();
        }
        expect(assertCompleteTasks({tasks: []})).toEqual([]);
        for (const result of [{}, {tasks: [], node_failures: ['missing']}, {tasks: [], task_failures: ['failed']}]) {
            expect(() => assertCompleteTasks(result)).toThrow();
        }
    });
    it('accepts explicit cancellation errors or cancelled failed shards, never complete HTTP success', () => {
        expect(() => assertCancelled({ok: false, error: {name: 'RequestAbortedError'}})).not.toThrow();
        expect(() => assertCancelled({ok: true, body: {_shards: {failed: 1, failures: [
            {reason: {type: 'task_cancelled_exception', reason: 'task cancelled by user'}}]}}})).not.toThrow();
        expect(() => assertCancelled({ok: true, body: {_shards: {failed: 0, failures: []}}})).toThrow();
        expect(() => assertCancelled({ok: true, body: {_shards: {failed: 1, failures: [{reason: 'ordinary failure'}]}}})).toThrow();
    });
    it('rejects duplicate/unknown options and inherits explicit loopback/ownership bounds', () => {
        const args = ['--url', 'http://127.0.0.1:56199', '--cluster-name', 'hyperion-es198-test', '--cluster-uuid',
            '_JnQI3_-Rx6hioLpSKM_rw', '--prefix', 'hyp-es955-abcdef123456', '--output', 'new.json'];
        expect(parseFailureOptions(args).documents).toBe(1000);
        for (const extra of [['--output', 'other.json'], ['--documents', '999999'], ['--transport', 'bad'], ['--transport']]) {
            expect(() => parseFailureOptions([...args, ...extra])).toThrow();
        }
        expect(() => parseFailureOptions(args.map(value => value === 'http://127.0.0.1:56199' ? 'http://production:9200' : value))).toThrow();
    });
});
