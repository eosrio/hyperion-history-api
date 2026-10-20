import {expect, test} from 'bun:test';
import {
    PROJECTION_CAPABILITIES, ProjectionContractError,
    type ProjectionAdapter, type ProjectionApplyRequest, type ProjectionBinding,
    type ProjectionDefinition, type ProjectionReadView,
} from '@eosrio/hyperion-sdk/projection';
import {DeclarativeProjectionRuntime, type ProjectionFrame} from '../../src/indexer/projection/runtime.js';

const zero = '0'.repeat(64);
const definition: ProjectionDefinition = {
    schemaVersion: 1, id: 'inventory', mappingRevision: 'a'.repeat(64),
    source: {contract: 'items', table: 'inventory', abiDeployment: 'abi-at-genesis', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'owner', path: ['owner'], type: 'string'}, {name: 'quantity', path: ['stats', 'quantity'], type: 'integer'}],
    initialization: {kind: 'genesis'},
};
const binding: ProjectionBinding = {chainId: 'c'.repeat(64), backendId: 'test-backend', projectionId: 'inventory',
    mappingRevision: 'a'.repeat(64), abiDeployment: 'abi-at-genesis', abiSha256: 'b'.repeat(64), generation: 'fixed-instance'};
const block = (n: number) => ({blockNum: n, blockId: String(n).padStart(64, '0'), previousBlockId: n === 1 ? zero : String(n - 1).padStart(64, '0')});
const frame = (n: number, owner = 'alice'): ProjectionFrame => ({chainId: binding.chainId, block: block(n), changes: [{
    contract: 'items', table: 'inventory', scope: 'items', primaryKey: '0x00:opaque', present: true,
    abiDeployment: binding.abiDeployment, abiSha256: binding.abiSha256, value: {owner, stats: {quantity: n}},
}]});
const deferred = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};

/** A second adapter at the public seam; durability is exercised separately against real MongoDB. */
function reference() {
    const requests: ProjectionApplyRequest[] = [];
    const failures: unknown[] = [];
    let view: ProjectionReadView = {binding, checkpoint: {blockNum: 0, blockId: zero}};
    let initializeCalls = 0, queryCalls = 0;
    const adapter: ProjectionAdapter = {
        capabilities: {interfaceVersion: 1, supported: [...PROJECTION_CAPABILITIES]},
        async initialize() {initializeCalls++; return structuredClone(view);},
        async open() {return structuredClone(view);},
        async apply(request) {requests.push(request); view = {binding: request.binding, checkpoint: {blockNum: request.block.blockNum, blockId: request.block.blockId}};
            return {status: 'applied', view: structuredClone(view)};},
        async markIncomplete(selected, failed, reason) {failures.push({binding: selected, block: failed, reason});},
        async query(selected) {queryCalls++; return {view: selected, rows: []};},
    };
    return {adapter, requests, failures, setView: (selected: ProjectionReadView) => {view = selected;},
        initializeCalls: () => initializeCalls, queryCalls: () => queryCalls};
}
const create = (adapter: ProjectionAdapter, options = {}) => DeclarativeProjectionRuntime.create({adapter, definition, binding,
    genesis: {blockNum: 0, blockId: zero}, ...options});

test('activation rejects missing capabilities before an adapter can provision storage', async () => {
    const fake = reference();
    Object.assign(fake.adapter, {capabilities: {interfaceVersion: 1, supported: []}});
    await expect(create(fake.adapter)).rejects.toMatchObject({code: 'projection.capability-unavailable'});
    expect(fake.initializeCalls()).toBe(0);
});

test('table mapping preserves opaque identities, ordered full replacements/deletes and empty source blocks', async () => {
    const fake = reference(), runtime = await create(fake.adapter);
    const first = frame(1);
    await runtime.process({...first, changes: [...first.changes, {...first.changes[0], present: false},
        {...first.changes[0], contract: 'unrelated'}]});
    await runtime.process({chainId: binding.chainId, block: block(2), changes: []});
    expect(fake.requests[0].previous).toEqual({blockNum: 0, blockId: zero});
    expect(fake.requests[0].mutations).toEqual([
        {kind: 'put', key: '["items","0x00:opaque"]', value: {owner: 'alice', quantity: 1}},
        {kind: 'delete', key: '["items","0x00:opaque"]'},
    ]);
    expect(fake.requests[1].previous).toEqual({blockNum: 1, blockId: block(1).blockId});
    expect(fake.requests[1].mutations).toEqual([]);
});

test('the bounded per-projection FIFO snapshots queued values before the first await', async () => {
    const fake = reference(), held = deferred(), entered = deferred();
    const originalApply = fake.adapter.apply.bind(fake.adapter);
    fake.adapter.apply = async request => {if (request.block.blockNum === 1) {entered.resolve(); await held.promise;} return originalApply(request);};
    const runtime = await create(fake.adapter, {maximumPendingFrames: 2});
    const first = runtime.process(frame(1)); await entered.promise;
    const queued = frame(2, 'bob'); const second = runtime.process(queued);
    (queued.changes[0].value as any).owner = 'tampered';
    await expect(runtime.process(frame(3))).rejects.toMatchObject({code: 'projection.apply-unavailable', retryable: true});
    expect(fake.requests).toHaveLength(0);
    held.resolve(); await Promise.all([first, second]);
    expect(fake.requests.map(request => request.block.blockNum)).toEqual([1, 2]);
    expect(fake.requests[1].mutations).toEqual([{kind: 'put', key: '["items","0x00:opaque"]', value: {owner: 'bob', quantity: 2}}]);
    await runtime.process(frame(3));
});

test('unrelated contract values and change counts cannot consume a projection budget or mark it incomplete', async () => {
    const selected = frame(1);
    const other = {...selected.changes[0], contract: 'unrelated'};
    const oversized = 'x'.repeat(4 * 1024 * 1024 + 1);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const unrelated of [
        [{...other, value: oversized}],
        Array.from({length: 10001}, () => other),
        [{...other, value: cycle}],
        [{...selected.changes[0], table: 'unrelated', value: oversized}],
    ]) {
        const fake = reference(), runtime = await create(fake.adapter);
        expect((await runtime.process({...selected, changes: [...unrelated, ...selected.changes]})).status).toBe('applied');
        expect(fake.failures).toHaveLength(0);
        expect(fake.requests[0].mutations).toEqual([
            {kind: 'put', key: '["items","0x00:opaque"]', value: {owner: 'alice', quantity: 1}},
        ]);
    }
});

test('contract/ABI errors durably mark the affected source before any mutation application', async () => {
    const fake = reference(), runtime = await create(fake.adapter);
    const invalid = frame(1); (invalid.changes[0].value as any).stats.quantity = Number.MAX_SAFE_INTEGER + 1;
    await expect(runtime.process(invalid)).rejects.toMatchObject({code: 'projection.invalid-contract'});
    expect(fake.failures).toHaveLength(1); expect(fake.requests).toHaveLength(0);
    const wrongAbi = frame(1); (wrongAbi.changes[0] as any).abiSha256 = 'd'.repeat(64);
    await expect(runtime.process(wrongAbi)).rejects.toMatchObject({code: 'projection.invalid-contract'});
    expect(fake.failures).toHaveLength(2);
    const other = reference(); await (await create(other.adapter)).process(frame(1));
    expect(other.requests).toHaveLength(1);
    await runtime.process(frame(1)); expect(fake.requests).toHaveLength(1);
});

test('a failed durable failure marker cannot become a successful processing result', async () => {
    const fake = reference(); fake.adapter.markIncomplete = async () => {throw new Error('storage unavailable');};
    const runtime = await create(fake.adapter), invalid = frame(1);
    (invalid.changes[0].value as any).owner = null;
    await expect(runtime.process(invalid)).rejects.toMatchObject({code: 'projection.apply-unavailable', retryable: true});
    expect(fake.requests).toHaveLength(0);
});

test('restart attaches an incomplete instance for exact replay without granting query readiness', async () => {
    const fake = reference();
    let incomplete = true;
    fake.adapter.initialize = async () => {throw new ProjectionContractError('projection.incomplete', 'Replay required');};
    fake.adapter.open = async () => {
        if (incomplete) throw new ProjectionContractError('projection.incomplete', 'Replay required');
        return {binding, checkpoint: {blockNum: 1, blockId: block(1).blockId}};
    };
    const apply = fake.adapter.apply.bind(fake.adapter);
    fake.adapter.apply = async request => {const result = await apply(request); incomplete = false; return result;};
    const runtime = await create(fake.adapter);
    await expect(runtime.query({filter: [], limit: 1})).rejects.toMatchObject({code: 'projection.incomplete'});
    await runtime.process(frame(1));
    expect((await runtime.open()).checkpoint).toEqual({blockNum: 1, blockId: block(1).blockId});
    fake.adapter.initialize = async () => {throw new ProjectionContractError('projection.stale-view', 'Binding mismatch');};
    await expect(create(fake.adapter)).rejects.toMatchObject({code: 'projection.stale-view'});
});

test('write rejection propagates and leaves the local queue available for explicit replay', async () => {
    const fake = reference(), apply = fake.adapter.apply.bind(fake.adapter); let reject = true;
    fake.adapter.apply = async request => {if (reject) throw new ProjectionContractError('projection.apply-unavailable', 'retry'); return apply(request);};
    const runtime = await create(fake.adapter);
    await expect(runtime.process(frame(1))).rejects.toMatchObject({code: 'projection.apply-unavailable'});
    reject = false; await runtime.process(frame(1)); expect(fake.requests).toHaveLength(1);
});

test('query inputs are snapshotted before opening a view, and publication checks the resulting checkpoint', async () => {
    const fake = reference(), held = deferred(), entered = deferred(); let opens = 0;
    fake.adapter.open = async () => {if (++opens === 1) {entered.resolve(); await held.promise;} return {binding, checkpoint: {blockNum: 0, blockId: zero}};};
    let received: unknown;
    fake.adapter.query = async (view, query) => {received = query; return {view, rows: []};};
    const runtime = await create(fake.adapter), query = {filter: [{field: 'owner', op: 'eq' as const, value: 'alice'}], limit: 3};
    const result = runtime.query(query); await entered.promise; query.filter[0].value = 'changed'; held.resolve(); await result;
    expect(received).toEqual({filter: [{field: 'owner', op: 'eq', value: 'alice'}], limit: 3});
    fake.adapter.open = async () => ({binding, checkpoint: {blockNum: 1, blockId: block(1).blockId}});
    await expect(runtime.query({filter: [], limit: 3}, {binding, checkpoint: {blockNum: 0, blockId: zero}}))
        .rejects.toMatchObject({code: 'projection.stale-view'});
});

test('another chain or backend view is rejected without poisoning or querying another projection', async () => {
    const fake = reference(), runtime = await create(fake.adapter);
    await expect(runtime.process({...frame(1), chainId: 'd'.repeat(64)})).rejects.toMatchObject({code: 'projection.invalid-contract'});
    await expect(runtime.query({filter: [], limit: 1}, {binding: {...binding, backendId: 'other'}, checkpoint: {blockNum: 0, blockId: zero}}))
        .rejects.toMatchObject({code: 'projection.stale-view'});
    expect(fake.failures).toHaveLength(0); expect(fake.queryCalls()).toBe(0);
});
