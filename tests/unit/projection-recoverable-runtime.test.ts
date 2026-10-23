import {expect, test} from 'bun:test';
import {PROJECTION_ROLLBACK_CAPABILITIES, ProjectionContractError,
    type ProjectionBinding, type ProjectionCheckpoint, type ProjectionDefinition,
    type ProjectionRollbackAdapter, type ProjectionRollbackApplyRequest,
    type ProjectionRollbackRecoveryView, type ProjectionRollbackRequest} from '@eosrio/hyperion-sdk/projection';
import {RecoverableProjectionRuntime} from '../../src/indexer/projection/recoverable-runtime.js';
import type {ProjectionFrame} from '../../src/indexer/projection/runtime.js';

const zero = '0'.repeat(64);
const definition: ProjectionDefinition = {schemaVersion: 1, id: 'inventory', mappingRevision: 'a'.repeat(64),
    source: {contract: 'items', table: 'inventory', abiDeployment: 'genesis-abi', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};
const binding: ProjectionBinding = {chainId: 'c'.repeat(64), backendId: 'test-backend', projectionId: 'inventory',
    mappingRevision: definition.mappingRevision, abiDeployment: definition.source.abiDeployment,
    abiSha256: definition.source.abiSha256, generation: 'immutable-instance'};
const checkpoint = (n: number): ProjectionCheckpoint => ({blockNum: n, blockId: String(n).padStart(64, '0')});
const frame = (n: number): ProjectionFrame => ({chainId: binding.chainId,
    block: {...checkpoint(n), previousBlockId: checkpoint(n - 1).blockId}, changes: [{contract: 'items', table: 'inventory',
        scope: 'items', primaryKey: '1', abiDeployment: binding.abiDeployment, abiSha256: binding.abiSha256,
        present: true, value: {owner: 'alice'}}]});
const deferred = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};

/** Exercises scheduling and fencing at the public seam; native storage/crashes have a real fixture. */
function reference(initial = 0) {
    let revision = 'd'.repeat(64), current = checkpoint(initial);
    let revisionNumber = 0;
    let operation: ProjectionRollbackRecoveryView['rollback'] = null;
    let initializeCalls = 0;
    const batches: ProjectionRollbackApplyRequest[] = [], rollbacks: ProjectionRollbackRequest[] = [];
    const recovery = (): ProjectionRollbackRecoveryView => ({binding, checkpoint: current, revision, initialized: true,
        pending: null, gap: null, rollback: operation,
        coverage: {floor: checkpoint(0), retainedBlocks: current.blockNum, retainedBytes: current.blockNum * 128,
            maxBlocks: 256, maxBytes: 64 * 1024 * 1024}});
    const available = () => {
        if (operation && operation.status !== 'complete') throw new ProjectionContractError('projection.incomplete', 'Recovering');
    };
    const view = () => ({binding, checkpoint: current, revision});
    const checkRevision = (selected: string) => {
        if (selected !== revision) throw new ProjectionContractError('projection.stale-revision', 'Old writer');
    };
    const adapter: ProjectionRollbackAdapter = {
        capabilities: {interfaceVersion: 2, supported: PROJECTION_ROLLBACK_CAPABILITIES},
        async initialize() {initializeCalls++; available(); return structuredClone(view());},
        async open() {available(); return structuredClone(view());},
        async recovery() {return structuredClone(recovery());},
        async apply(request) {checkRevision(request.revision); available(); batches.push(request);
            current = {blockNum: request.batch.block.blockNum, blockId: request.batch.block.blockId};
            return {status: 'applied', view: structuredClone(view())};},
        async markIncomplete(request) {checkRevision(request.revision);},
        async query(selected) {checkRevision(selected.revision); available();
            if (selected.checkpoint.blockId !== current.blockId || selected.checkpoint.blockNum !== current.blockNum)
                throw new ProjectionContractError('projection.stale-view', 'Old checkpoint');
            return {view: structuredClone(view()), rows: []};},
        async rollback(request) {
            rollbacks.push(request);
            if (operation?.operationId === request.operationId && operation.status === 'complete')
                return {status: 'duplicate', recovery: structuredClone(recovery())};
            if (!operation || operation.operationId !== request.operationId) {
                checkRevision(request.revision);
                if (request.from.blockNum !== current.blockNum || request.from.blockId !== current.blockId)
                    throw new ProjectionContractError('projection.stale-view', 'Old recovery checkpoint');
                revision = ['e', 'f', '1', '2'][revisionNumber++].repeat(64);
                operation = {operationId: request.operationId, sourceRevision: request.revision, from: current,
                    ancestor: request.ancestor, status: 'running', reason: null};
            }
            current = checkpoint(Math.max(request.ancestor.blockNum, current.blockNum - request.maxBlocks));
            if (current.blockNum === request.ancestor.blockNum) operation = {...operation, status: 'complete'};
            return {status: operation.status === 'complete' ? 'rolled-back' : 'in-progress', recovery: structuredClone(recovery())};
        },
    };
    return {adapter, batches, rollbacks, initializeCalls: () => initializeCalls,
        unavailable(request: ProjectionRollbackRequest) {
            revision = 'e'.repeat(64);
            operation = {operationId: request.operationId, sourceRevision: request.revision, from: current,
                ancestor: request.ancestor, status: 'unavailable', reason: 'Input gap'};
        }};
}
const create = (adapter: ProjectionRollbackAdapter, options = {}) => RecoverableProjectionRuntime.create({adapter, definition,
    binding, genesis: checkpoint(0), ...options});
const plan = (operationId: string, from: ProjectionCheckpoint, ancestor = checkpoint(0), maxBlocks = 1,
    revision = 'd'.repeat(64)): ProjectionRollbackRequest => ({binding, revision, operationId, from, ancestor, maxBlocks});

test('rollback capability, genesis and pending bounds fail before native initialization', async () => {
    for (const options of [{maximumPendingFrames: 0}, {maximumPendingBytes: 64 * 1024 * 1024 + 1}, {genesis: checkpoint(1)}]) {
        const fake = reference();
        await expect(create(fake.adapter, options)).rejects.toMatchObject({code: 'projection.invalid-contract'});
        expect(fake.initializeCalls()).toBe(0);
    }
    const fake = reference(); Object.assign(fake.adapter, {capabilities: {interfaceVersion: 2, supported: []}});
    await expect(create(fake.adapter)).rejects.toMatchObject({code: 'projection.capability-unavailable'});
    expect(fake.initializeCalls()).toBe(0);
});

test('rollback invalidates queued work, drains an in-flight commit and inspects its actual checkpoint', async () => {
    const fake = reference(), entered = deferred(), release = deferred(), apply = fake.adapter.apply.bind(fake.adapter);
    fake.adapter.apply = async request => {entered.resolve(); await release.promise; return apply(request);};
    const runtime = await create(fake.adapter);
    const first = runtime.process(frame(1)); await entered.promise;
    const queued = runtime.process(frame(2));
    // Observe the old work before releasing the deliberately held writer.
    const rejected = Promise.allSettled([first, queued]);
    const rollback = runtime.rollback(plan('fork-a', checkpoint(1)));
    await expect(runtime.process(frame(3))).rejects.toMatchObject({code: 'projection.incomplete'});
    await expect(runtime.open()).rejects.toMatchObject({code: 'projection.incomplete'});
    expect(fake.rollbacks).toHaveLength(0);
    release.resolve();
    expect((await rejected).every(value => value.status === 'rejected')).toBe(true);
    expect((await rollback).status).toBe('rolled-back');
    expect(fake.batches.map(value => value.batch.block.blockNum)).toEqual([1]);
    expect(fake.rollbacks[0].from).toEqual(checkpoint(1));
    expect(fake.rollbacks[0].revision).toBe('d'.repeat(64));
    expect((await runtime.open()).revision).toBe('e'.repeat(64));
    await runtime.process(frame(1));
    expect(fake.batches[1].revision).toBe('e'.repeat(64));
});

test('partial recovery remains non-serving through restart; matching calls resume original operation identity', async () => {
    const fake = reference(2), runtime = await create(fake.adapter);
    const options = plan('fork-b', checkpoint(2));
    expect((await runtime.rollback(options)).status).toBe('in-progress');
    expect((await runtime.recovery()).checkpoint).toEqual(checkpoint(1));
    await expect(runtime.query({filter: [], limit: 1})).rejects.toMatchObject({code: 'projection.incomplete'});
    const restarted = await create(fake.adapter);
    await expect(restarted.process(frame(2))).rejects.toMatchObject({code: 'projection.incomplete'});
    expect((await restarted.rollback(options)).status).toBe('rolled-back');
    expect(fake.rollbacks.map(value => value.revision)).toEqual(['d'.repeat(64), 'd'.repeat(64)]);
    expect(fake.rollbacks.map(value => value.from)).toEqual([checkpoint(2), checkpoint(2)]);
    await restarted.process(frame(1));
    expect((await restarted.rollback(options)).status).toBe('duplicate');
    expect((await restarted.open()).checkpoint).toEqual(checkpoint(1));
});

test('a pre-fork view stays fenced even when the exact old checkpoint is reached again', async () => {
    const fake = reference(), runtime = await create(fake.adapter), old = await runtime.open();
    await runtime.process(frame(1));
    await runtime.rollback(plan('fork-c', checkpoint(1)));
    expect((await runtime.open()).checkpoint).toEqual(old.checkpoint);
    await expect(runtime.query({filter: [], limit: 1}, old)).rejects.toMatchObject({code: 'projection.stale-revision'});
    expect((await runtime.query({filter: [], limit: 1})).view.revision).toBe('e'.repeat(64));
});

test('rollback options are captured without getters and cannot be changed during quiescence', async () => {
    const fake = reference(), runtime = await create(fake.adapter);
    let getterCalled = false;
    const invalid = {...plan('bad', checkpoint(0)), get operationId() {getterCalled = true; return 'bad';}};
    await expect(runtime.rollback(invalid)).rejects.toMatchObject({code: 'projection.invalid-contract'});
    expect(getterCalled).toBe(false); expect(fake.rollbacks).toHaveLength(0);
    const input = plan('captured', checkpoint(0));
    const work = runtime.rollback(input);
    input.operationId = 'tampered'; input.ancestor.blockId = 'f'.repeat(64); input.maxBlocks = 9999;
    await work;
    expect(fake.rollbacks[0]).toMatchObject({operationId: 'captured', ancestor: checkpoint(0), maxBlocks: 1});
});

test('unavailable rollback never reopens the affected lane or prevents another projection from running', async () => {
    const fake = reference(2), other = reference(), runtime = await create(fake.adapter), healthy = await create(other.adapter);
    fake.adapter.rollback = async request => {fake.unavailable(request); throw new ProjectionContractError('projection.rollback-unavailable', 'Input gap');};
    await expect(runtime.rollback(plan('gap', checkpoint(2))))
        .rejects.toMatchObject({code: 'projection.rollback-unavailable', retryable: true});
    await expect(runtime.open()).rejects.toMatchObject({code: 'projection.incomplete'});
    await healthy.process(frame(1));
    expect((await healthy.open()).checkpoint).toEqual(checkpoint(1));
});

test('a retired rollback retry preserves its original fence and cannot rewind a newer branch', async () => {
    const fake = reference(2), runtime = await create(fake.adapter);
    const first = plan('first-fork', checkpoint(2), checkpoint(0), 2);
    await runtime.rollback(first);
    await runtime.process(frame(1)); await runtime.process(frame(2));
    await runtime.rollback(plan('second-fork', checkpoint(2), checkpoint(1), 1, 'e'.repeat(64)));
    await runtime.process(frame(2));
    const before = await runtime.open();
    await expect(runtime.rollback(first)).rejects.toMatchObject({code: 'projection.stale-revision'});
    expect(fake.rollbacks.at(-1)).toEqual(first);
    expect(await runtime.open()).toEqual(before);
    expect((await runtime.query({filter: [], limit: 1})).view).toEqual(before);
});

test('a source checkpoint changed by an in-flight commit is refused rather than silently replanned', async () => {
    const fake = reference(), entered = deferred(), release = deferred(), apply = fake.adapter.apply.bind(fake.adapter);
    fake.adapter.apply = async request => {entered.resolve(); await release.promise; return apply(request);};
    const runtime = await create(fake.adapter);
    const processing = runtime.process(frame(1)); await entered.promise;
    const settled = Promise.allSettled([processing]);
    const stalePlan = plan('planned-before-commit', checkpoint(0));
    const rollback = runtime.rollback(stalePlan);
    release.resolve(); await settled;
    await expect(rollback).rejects.toMatchObject({code: 'projection.stale-view'});
    expect(fake.rollbacks[0]).toEqual(stalePlan);
    expect((await runtime.open()).checkpoint).toEqual(checkpoint(1));
    await runtime.rollback(plan('planned-after-commit', checkpoint(1)));
    expect((await runtime.open()).checkpoint).toEqual(checkpoint(0));
});
