import {expect, test} from 'bun:test';
import {CRASH_BOUNDARIES, classifyMongoCommand, matchesCrashBoundary, serializeWorkerError, validateWorkerJob}
    from '../../scripts/qualification/projection-rollback-worker.mjs';
import {captureRollbackPlan, RECOVERY_RETRY_LIMITS, retryAcknowledgedUnavailable, runRollbackWorker}
    from '../../scripts/qualification/projection-rollback.mjs';

const job = () => ({schemaVersion: 1, action: 'inspect', uri: 'mongodb://127.0.0.1:58321/?directConnection=true',
    databaseName: 'owned_fixture', collectionPrefix: 'h45_rollback', backendId: 'fixture-backend', definition: {}, binding: {}});

test('native child launch requires successful resource ownership proof before parsing or connecting', async () => {
    const children = new Set();
    await expect(runRollbackWorker(job(), {children})).rejects.toThrow('prove ownership');
    let checked = 0;
    await expect(runRollbackWorker({...job(), uri: 'mongodb://operator:27017'}, {children, assertOwned() {
        checked++; throw new Error('Owned fixture identity changed');
    }})).rejects.toThrow('Owned fixture identity changed');
    expect(checked).toBe(1);
    expect(children.size).toBe(0);
});

test('crash child rejects default/remote/authenticated endpoints and storage override injection', () => {
    expect(validateWorkerJob(job())).toEqual(job());
    expect(validateWorkerJob({...job(), uri: 'mongodb://127.0.0.1:58321/?replicaSet=hyp45p21&directConnection=true'}).databaseName)
        .toBe('owned_fixture');
    for (const uri of ['mongodb://127.0.0.1:27017', 'mongodb://localhost:58321', 'mongodb://10.0.0.1:58321',
        'mongodb://user:secret@127.0.0.1:58321', 'mongodb://127.0.0.1:58321/operator',
        'mongodb://127.0.0.1:58321/?directConnection=false',
        'mongodb://127.0.0.1:58321/?directConnection=true&directConnection=false',
        'mongodb://127.0.0.1:58321/?authSource=admin', 'mongodb+srv://127.0.0.1:58321'])
        expect(() => validateWorkerJob({...job(), uri})).toThrow();
    for (const fields of [{databaseName: undefined}, {collectionPrefix: undefined}, {backendId: ''},
        {databaseName: 'unsafe.name'}, {collectionPrefix: '$unsafe'}, {adapterOptions: {databaseName: 'operator'}},
        {adapterOptions: {client: {}}}, {adapterOptions: {rollbackRetentionBlocks: 0}}, {adapterOptions: []},
        {crash: 'arbitrary-boundary'}, {action: 'drop'}]) expect(() => validateWorkerJob({...job(), ...fields})).toThrow();
});

test('durable barriers classify only this fixture metadata and the required write shape', () => {
    const event = (name: string, command: object, databaseName = 'fixture') => ({commandName: name, command, databaseName});
    const classify = (value: object) => classifyMongoCommand(value, 'fixture', 'h45_rollback');
    expect(classify(event('findAndModify', {findAndModify: 'h45_rollback_metadata', update: {$set: {pending: {digest: 'a'.repeat(64)}}}})))
        .toBe('apply-intent');
    expect(classify(event('findAndModify', {findAndModify: 'h45_rollback_metadata', update: {$set: {revision: 'b'.repeat(64), rollback: {status: 'running'}}}})))
        .toBe('rollback-intent');
    expect(classify(event('update', {update: 'h45_rollback_metadata', updates: [{u: {$set: {checkpoint: {}, undo: []}}}]})))
        .toBe('apply');
    for (const status of ['running', 'complete'])
        expect(classify(event('update', {update: 'h45_rollback_metadata', updates: [{u: {$set: {checkpoint: {}, undo: [], rollback: {status}}}}]})))
            .toBe('rollback-step');
    for (const value of [
        event('findAndModify', {findAndModify: 'h45_rollback_metadata', update: {$set: {pending: {digest: null}}}}),
        event('findAndModify', {findAndModify: 'h45_rollback_metadata', update: {$set: {pending: {digest: 'a'.repeat(64)}}}}, 'operator'),
        event('findAndModify', {findAndModify: 'operator_metadata', update: {$set: {revision: 'a', rollback: {}}}}),
        event('update', {update: 'h45_rollback_records', updates: [{u: {$set: {checkpoint: {}, undo: []}}}]}),
        event('update', {update: 'h45_rollback_metadata', updates: [{u: {$set: {checkpoint: {}}}}]}),
        event('delete', {delete: 'h45_rollback_metadata'}),
    ]) expect(classify(value)).toBeUndefined();
});

test('crash matrix separates prepare, transaction send, durable commit and undo progress', () => {
    const examples = [
        ['after-apply-intent', 'apply-intent', 'succeeded'],
        ['before-apply-commit', 'apply', 'commit-started'],
        ['after-apply-commit', 'apply', 'commit-succeeded'],
        ['after-rollback-intent', 'rollback-intent', 'succeeded'],
        ['before-rollback-commit', 'rollback-step', 'commit-started'],
        ['after-rollback-step', 'rollback-step', 'commit-succeeded'],
    ];
    expect(CRASH_BOUNDARIES).toContain('after-result');
    for (const [boundary, phase, stage] of examples) {
        expect(matchesCrashBoundary(boundary, phase, stage)).toBe(true);
        for (const other of CRASH_BOUNDARIES.filter((value: string) => value !== boundary))
            expect(matchesCrashBoundary(other, phase, stage)).toBe(false);
        expect(matchesCrashBoundary(boundary, 'unrelated', stage)).toBe(false);
    }
});

const unavailable = (pid: number) => Object.assign(new Error('Acknowledged unavailable worker'), {
    workerAcknowledged: true, code: 'projection.apply-unavailable', retryable: true,
    worker: {pid, node: 'v24.19.0', trace: [{command: 'update', stage: 'failed'}], error: {cause: {code: 50, message: 'operation timeout'}}},
});

test('full recovery plan freezes original revision/from across later recovery snapshots and retries', async () => {
    const binding = {chainId: 'a'.repeat(64), backendId: 'fixture', projectionId: 'items', mappingRevision: 'b'.repeat(64),
        abiDeployment: 'fixture:1', abiSha256: 'c'.repeat(64), generation: 'instance'};
    const recovery = {binding, revision: 'd'.repeat(64), checkpoint: {blockNum: 4, blockId: 'e'.repeat(64)}};
    const ancestor = {blockNum: 1, blockId: 'f'.repeat(64)};
    const plan = captureRollbackPlan(recovery, 'first-operation', ancestor, 1);
    recovery.revision = '1'.repeat(64); recovery.checkpoint.blockNum = 9; ancestor.blockNum = 0;
    expect(plan.revision).toBe('d'.repeat(64));
    expect(plan.from).toEqual({blockNum: 4, blockId: 'e'.repeat(64)});
    expect(plan.ancestor.blockNum).toBe(1);
    expect(Object.isFrozen(plan)).toBe(true);
    let attempts = 0;
    const requests: unknown[] = [], failures: unknown[] = [];
    await retryAcknowledgedUnavailable({deadline: 180_000, failures, now: () => 0,
        operation: async () => {requests.push(plan); if (++attempts === 1) throw unavailable(1); return 'completed';},
        observeFailure: async () => ({checkpoint: plan.from, pending: true})});
    expect(requests).toEqual([plan, plan]);
    expect(requests[0]).toBe(requests[1]);
    expect(failures).toHaveLength(1);
});

test('acknowledged unavailable retry records every failed process and physical check before another exact attempt', async () => {
    let clock = 0, observations = 0;
    const timeouts: number[] = [], failures: any[] = [];
    const result = await retryAcknowledgedUnavailable({deadline: RECOVERY_RETRY_LIMITS.deadlineMS, failures, now: () => clock,
        context: {boundary: 'before-apply-commit'},
        operation: async ({attempt, timeoutMS}: {attempt: number; timeoutMS: number}) => {
            expect(observations).toBe(attempt - 1);
            timeouts.push(timeoutMS); clock += 61_000;
            if (attempt < 3) throw unavailable(attempt);
            clock = 150_000; return 'exact-source-completed';
        },
        observeFailure: async (error: any) => {observations++; return {checkpoint: 1, pending: 2, pid: error.worker.pid};},
    });
    expect(result).toBe('exact-source-completed');
    expect(timeouts).toEqual([120_000, 119_000, 58_000]);
    expect(failures.map(failure => failure.process.pid)).toEqual([1, 2]);
    expect(failures.map(failure => failure.physical)).toEqual([{checkpoint: 1, pending: 2, pid: 1}, {checkpoint: 1, pending: 2, pid: 2}]);
    expect(failures[0].process.error.cause.code).toBe(50);
});

test('unexpected errors, unacknowledged failures and non-retryable errors never trigger fixture retry', async () => {
    for (const fields of [{workerAcknowledged: false}, {code: 'projection.stale-revision'}, {retryable: false}]) {
        let attempts = 0, observed = 0;
        const failures: unknown[] = [], error = Object.assign(unavailable(1), fields);
        await expect(retryAcknowledgedUnavailable({deadline: 180_000, failures, now: () => 0,
            operation: async () => {attempts++; throw error;}, observeFailure: async () => {observed++;}})).rejects.toBe(error);
        expect(attempts).toBe(1); expect(observed).toBe(0); expect(failures).toHaveLength(0);
    }
});

test('attempt and shared-deadline caps retain the final acknowledged failure and never report late success', async () => {
    let attempts = 0;
    const failures: unknown[] = [];
    await expect(retryAcknowledgedUnavailable({deadline: 180_000, failures, now: () => 0,
        operation: async () => {throw unavailable(++attempts);}, observeFailure: async () => ({checkpoint: 1, pending: 2})})).rejects.toThrow();
    expect(attempts).toBe(3); expect(failures).toHaveLength(3);
    let clock = 0, inspected = 0;
    await expect(retryAcknowledgedUnavailable({deadline: 180_000, failures: [], now: () => clock,
        operation: async () => {clock = 180_001; throw unavailable(4);}, observeFailure: async () => {inspected++;}})).rejects.toThrow();
    expect(inspected).toBe(1);
    clock = 0;
    await expect(retryAcknowledgedUnavailable({deadline: 180_000, failures: [], now: () => clock,
        operation: async () => {clock = 180_001; return 'too late';}, observeFailure: async () => {}})).rejects.toThrow('deadline');
});

test('worker errors retain bounded native cause/labels and terminate circular or expanding causes', () => {
    const native = Object.assign(new Error('Mongo operation timeout'), {code: 50, errorLabels: ['TransientTransactionError']});
    const wrapped = Object.assign(new Error('Adapter unavailable', {cause: native}), {code: 'projection.apply-unavailable', retryable: true});
    const evidence = serializeWorkerError(wrapped);
    expect(evidence.code).toBe('projection.apply-unavailable'); expect(evidence.retryable).toBe(true);
    expect(evidence.cause.code).toBe(50); expect(evidence.cause.labels).toEqual(['TransientTransactionError']);
    const cycle: any = new Error('cycle'); cycle.cause = cycle;
    expect(serializeWorkerError(cycle).cause.truncated).toBe(true);
    const huge = new AggregateError(Array.from({length: 100}, () => new Error('😀'.repeat(20_000))), 'huge');
    expect(Buffer.byteLength(JSON.stringify(serializeWorkerError(huge)))).toBeLessThan(40 * 1024);
});
