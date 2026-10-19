import {test, expect} from 'bun:test';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {assertOwnedBinding, assertPausedRange, assertSortedPage, loadDocument, runWorkerQualification,
    validateWorkerRunOptions, observeAmqpErrors, assertSuccessfulWorkerShutdown} from '../../scripts/qualification/es955-workers.ts';

test('incompatible profiling duration is rejected before manifest or output access', async () => {
    await expect(runWorkerQualification('nonexistent-profile-preflight.json', 'unused-profile-preflight', 900, 200, true))
        .rejects.toThrow(/profiling.*600/);
});

test('profiling lifecycle headroom is validated without restricting long controls', () => {
    expect(() => validateWorkerRunOptions(300, 200, true)).not.toThrow();
    expect(() => validateWorkerRunOptions(600, 200, true)).not.toThrow();
    expect(() => validateWorkerRunOptions(601, 200, true)).toThrow(/profiling.*600/);
    expect(() => validateWorkerRunOptions(900, 200, false)).not.toThrow();
});

test('asynchronous AMQP model and publisher errors are captured during work and cleanup', async () => {
    const {ChannelModel, ConfirmChannel} = createRequire(import.meta.url)(
        fileURLToPath(new URL('../../node_modules/amqplib/lib/channel_model.js', import.meta.url)));
    const transport = new EventEmitter();
    // Use the installed amqplib classes and the real connection-error forwarder.
    // No connection handshake or external listener is needed for these events.
    const broker = new ChannelModel(transport); const publisher = new ConfirmChannel(transport);
    const failures: {source: string; error: Error}[] = [];
    const capture = (source: string, error: Error) => { failures.push({source, error}); };
    expect(observeAmqpErrors(broker, 'connection', capture)).toBe(broker);
    expect(observeAmqpErrors(publisher, 'publisher', capture)).toBe(publisher);
    const error = new Error('broker failed asynchronously');
    await new Promise<void>(resolve => setImmediate(() => { transport.emit('error', error); resolve(); }));
    expect(failures).toEqual([{source: 'connection', error}]);
    await new Promise<void>(resolve => setImmediate(() => { publisher.emit('error', 'publisher failed during close'); resolve(); }));
    expect(failures).toHaveLength(2);
    expect(failures[1].source).toBe('publisher');
    expect(failures[1].error.message).toBe('publisher failed during close');
    publisher.emit('error', error);
    expect(failures).toHaveLength(3);
});

test('shutdown oracle rejects failed, signalled, missing and unclean process exits', () => {
    const rows = (): any[] => [{kind: 'start', pid: 1}, {kind: 'start', pid: 2},
        {kind: 'worker_fork', pid: 1, childPid: 2},
        {kind: 'worker_exit', pid: 1, childPid: 2, code: 0, signal: null},
        {kind: 'exit', pid: 2, code: 0}, {kind: 'exit', pid: 1, code: 0},
        {kind: 'shutdown', pid: 1, success: true, forced: [], unresolved: [], failedChildren: [],
            childExits: [{pid: 2, clusterId: 1, code: 0, signal: null}]}];
    expect(() => assertSuccessfulWorkerShutdown(rows(), 1, 0, null)).not.toThrow();
    expect(() => assertSuccessfulWorkerShutdown(rows(), 1, 1, null)).toThrow();
    expect(() => assertSuccessfulWorkerShutdown(rows(), 1, null, 'SIGTERM')).toThrow();
    const childFailure = rows(); childFailure[4].code = 1;
    expect(() => assertSuccessfulWorkerShutdown(childFailure, 1, 0, null)).toThrow();
    const childSignal = rows(); childSignal[3].code = null; childSignal[3].signal = 'SIGKILL';
    expect(() => assertSuccessfulWorkerShutdown(childSignal, 1, 0, null)).toThrow();
    expect(() => assertSuccessfulWorkerShutdown(rows().filter(row => !(row.kind === 'exit' && row.pid === 2)), 1, 0, null)).toThrow();
    const forced = rows(); forced[6].forced = [{pid: 2}];
    expect(() => assertSuccessfulWorkerShutdown(forced, 1, 0, null)).toThrow();
    const falseSuccess = rows(); falseSuccess[6].success = false;
    expect(() => assertSuccessfulWorkerShutdown(falseSuccess, 1, 0, null)).toThrow();
    const missingChild = rows(); missingChild[6].childExits = [];
    expect(() => assertSuccessfulWorkerShutdown(missingChild, 1, 0, null)).toThrow();
    expect(() => assertSuccessfulWorkerShutdown(rows().filter(row => row.kind !== 'worker_exit'), 1, 0, null)).toThrow();
    const failedChild = rows(); failedChild[6].childExits[0].code = 1;
    expect(() => assertSuccessfulWorkerShutdown(failedChild, 1, 0, null)).toThrow();
});

const page = () => ({timed_out: false, _shards: {failed: 0}, hits: {hits: [3, 2, 1].map(n =>
    ({_id: String(n), _source: loadDocument(n, 'oracle')}))}});

test('sustained query oracle rejects partial, reordered, unknown and corrupted documents', () => {
    expect(() => assertSortedPage(page(), 3, 'oracle')).not.toThrow();
    const timed = page(); timed.timed_out = true;
    expect(() => assertSortedPage(timed, 3, 'oracle')).toThrow();
    const partial = page(); partial._shards.failed = 1;
    expect(() => assertSortedPage(partial, 3, 'oracle')).toThrow();
    const reordered = page(); reordered.hits.hits.reverse();
    expect(() => assertSortedPage(reordered, 3, 'oracle')).toThrow();
    expect(() => assertSortedPage(page(), 2, 'oracle')).toThrow();
    const altered = page(); altered.hits.hits[0]._source.act.data.payload = 'changed';
    expect(() => assertSortedPage(altered, 3, 'oracle')).toThrow();
    const duplicate = page(); duplicate.hits.hits[1] = duplicate.hits.hits[0];
    expect(() => assertSortedPage(duplicate, 3, 'oracle')).toThrow();
    const empty = page(); empty.hits.hits = [];
    expect(() => assertSortedPage(empty, 3, 'oracle', 3, 3)).toThrow();
    expect(() => assertSortedPage(page(), 3, 'oracle', 3, 4)).toThrow();
});

test('fixture endpoint must match the actual owned Docker loopback binding', () => {
    const inspected = {NetworkSettings: {Ports: {'6379/tcp': [{HostIp: '127.0.0.1', HostPort: '54321'}]}}};
    expect(() => assertOwnedBinding(inspected, '6379/tcp', 'redis://127.0.0.1:54321')).not.toThrow();
    expect(() => assertOwnedBinding(inspected, '6379/tcp', 'redis://127.0.0.1:54322')).toThrow();
    expect(() => assertOwnedBinding(inspected, '27017/tcp', 'mongodb://127.0.0.1:54321')).toThrow();
});

test('reader pause oracle allows the current range and rejects a new request after a pending range', () => {
    const pause = {event: 'pause', role: 'reader', at: 100};
    const pending = {event: 'new_range', role: 'reader', at: 200};
    const continuing = {kind: 'ship_range_request', role: 'reader', at: 150};
    const live = {kind: 'ship_range_request', role: 'continuous_reader', at: 250};
    expect(() => assertPausedRange(pause, pending, [continuing, live], 300)).not.toThrow();
    expect(() => assertPausedRange(pause, pending, [continuing, {...continuing, at: 250}], 300)).toThrow();
    expect(() => assertPausedRange(pause, {...pending, at: 99}, [], 300)).toThrow();
    expect(() => assertPausedRange(pause, {...pending, at: 301}, [], 300)).toThrow();
    expect(() => assertPausedRange({...pause, role: 'continuous_reader'}, pending, [], 300)).toThrow();
});
