import {describe, expect, it} from 'bun:test';
import {assertCancelled, assertCollectionDeadline, assertCompleteTasks, assertFailedShard, assertRecovered, assertServerTaskCancelled, assertTimedOut, parseFailureOptions, recoveryCounters} from '../../scripts/qualification/es955-failures.ts';

describe('Elasticsearch fault qualification evidence', () => {
    it('requires a started delay and a timeout observed by the slow script for collection deadlines', () => {
        const response = {timed_out: true, _shards: {total: 4, failed: 0}};
        const observed = {delay_started: 1, slow_query_timed_out: 1};
        expect(() => assertCollectionDeadline(response, observed)).not.toThrow();
        for (const state of [{}, {delay_started: 0, slow_query_timed_out: 0},
            {delay_started: 1, slow_query_timed_out: 0}, {delay_started: 0, slow_query_timed_out: 1},
            {delay_started: 1, slow_cancelled: 1}, {delay_started: 1, slow_task_cancelled: 1},
            {delay_started: NaN, slow_query_timed_out: 1}, {delay_started: 1, slow_query_timed_out: Infinity},
            {delay_started: '1', slow_query_timed_out: 1}]) {
            expect(() => assertCollectionDeadline(response, state)).toThrow();
        }
        expect(() => assertCollectionDeadline({...response, timed_out: false}, observed)).toThrow();
    });
    it('requires true slow-task cancellation, rejecting client abort and timeout-only fixture evidence', () => {
        expect(() => assertServerTaskCancelled({task_cancelled: 1, slow_task_cancelled: 1})).not.toThrow();
        for (const state of [{}, {cancelled: 1, query_timed_out: 1, slow_query_timed_out: 1},
            {task_cancelled: 1, slow_task_cancelled: 0}, {task_cancelled: 0, slow_task_cancelled: 1},
            {cancelled: 1, task_cancelled: 1}, {task_cancelled: NaN, slow_task_cancelled: 1},
            {task_cancelled: 1, slow_task_cancelled: Infinity}, {task_cancelled: '1', slow_task_cancelled: 1}]) {
            expect(() => assertServerTaskCancelled(state)).toThrow();
        }
    });
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
