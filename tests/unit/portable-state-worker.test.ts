import {expect, test} from 'bun:test';
import {PROJECTION_ROLLBACK_CAPABILITIES, PROJECTION_RECOVERY_CAPABILITIES, ProjectionContractError,
    type ProjectionRecoveryAdapter, type ProjectionBinding, type ProjectionDefinition} from '@eosrio/hyperion-sdk/projection';
import {PortableStateController} from '../../src/indexer/projection/controller.js';
import {resolvePortableStateConfiguration} from '../../src/indexer/projection/config.js';
import {PortableProjectionFrameError} from '../../src/indexer/projection/source.js';
import {createPortableStateReadGate} from '../../src/indexer/projection/production.js';
import {createPortableStateQueryService} from '../../src/indexer/projection/query-service.js';

const zero = '0'.repeat(64), chainId = 'c'.repeat(64);
const block = (height: number) => ({blockNum: height, blockId: String(height).padStart(64, '0'),
    previousBlockId: height === 1 ? zero : String(height - 1).padStart(64, '0')});
const definition = (id = 'items'): ProjectionDefinition => ({schemaVersion: 1, id, mappingRevision: 'a'.repeat(64),
    source: {contract: 'items', table: id, abiDeployment: 'original-source-epoch', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}});
const config = (...definitions: ProjectionDefinition[]) => resolvePortableStateConfiguration({
    backend: {kind: 'mongodb', id: 'fixture-backend', database: 'fixture'}, projections: definitions}, chainId)!;
const deferred = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};

/** Adapter seam fixture only; real majority/transaction evidence belongs to the separate Mongo runner. */
function reference(initial = 0) {
    const slots = new Map<string, any>(), applied: any[] = [], marked: any[] = [], calls: any[] = [];
    const slot = (binding: ProjectionBinding) => slots.get(binding.projectionId);
    let failApply = 0, failMark = 0, rotations = 0;
    const rollbacks: any[] = [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const view = (value: any) => ({binding: value.binding, checkpoint: value.checkpoint, revision: value.revision});
    const available = (value: any) => {
        if (value.pending || value.gap || (value.rollback && value.rollback.status !== 'complete'))
            throw new ProjectionContractError('projection.incomplete', 'pending fixture source');
    };
    const fence = (value: any, revision: string) => {
        if (value.revision !== revision) throw new ProjectionContractError('projection.stale-revision', 'Old fixture revision');
    };
    const adapter: ProjectionRecoveryAdapter = {
        capabilities: {interfaceVersion: 2, supported: PROJECTION_ROLLBACK_CAPABILITIES},
        recoveryCapabilities: {interfaceVersion: 1, supported: PROJECTION_RECOVERY_CAPABILITIES},
        async initialize(_definition, binding) {calls.push('initialize');
            if (!slot(binding)) slots.set(binding.projectionId, {binding, checkpoint: {blockNum: initial, blockId: initial ? block(initial).blockId : zero},
                initialized: true, pending: null, gap: null, revision: 'd'.repeat(64), rollback: null,
                coverage: {floor: {blockNum: initial, blockId: initial ? block(initial).blockId : zero}, retainedBlocks: 0,
                    retainedBytes: 0, maxBlocks: 256, maxBytes: 1024 * 1024}});
            return this.open(binding);},
        async open(binding) {calls.push('open'); const value = slot(binding);
            available(value); return structuredClone(view(value));},
        async recovery(binding) {calls.push('recovery'); return structuredClone(slot(binding));},
        async retainedCheckpoints(request) {const value = slot(request.binding); fence(value, request.revision);
            const points = [value.checkpoint];
            for (let height = value.checkpoint.blockNum - 1; height >= value.coverage.floor.blockNum; height--)
                points.push({blockNum: height, blockId: height ? block(height).blockId : zero});
            return structuredClone({recovery: value, checkpoints: points});},
        async apply(input) {calls.push('apply'); const request = input.batch;
            const value = slot(request.binding); fence(value, input.revision);
            if (failApply-- > 0) throw new Error('transient fixture write');
            applied.push(structuredClone(request));
            value.checkpoint = {blockNum: request.block.blockNum, blockId: request.block.blockId}; value.pending = null;
            value.coverage.retainedBlocks = value.checkpoint.blockNum - value.coverage.floor.blockNum;
            value.coverage.retainedBytes = value.coverage.retainedBlocks * 128;
            if (value.gap && same(value.gap.block, request.block)) value.gap = null;
            return {status: 'applied', view: structuredClone(view(value))};},
        async markIncomplete({binding, revision, block: failedBlock, reason}) {calls.push('markIncomplete');
            const value = slot(binding); fence(value, revision);
            if (failMark-- > 0) throw new Error('fixture marker unavailable');
            marked.push({binding, failedBlock, reason}); value[failedBlock.blockNum > value.checkpoint.blockNum + 1 ? 'gap' : 'pending'] = {block: failedBlock, reason, digest: null};},
        async rollback(request) {const value = slot(request.binding); rollbacks.push(structuredClone(request));
            if (value.rollback?.operationId !== request.operationId) {
                fence(value, request.revision);
                if (!same(value.checkpoint, request.from)) throw new ProjectionContractError('projection.stale-view', 'Old checkpoint');
                value.revision = String(++rotations).padStart(64, '0');
                value.rollback = {operationId: request.operationId, sourceRevision: request.revision, from: request.from,
                    ancestor: request.ancestor, status: 'running', reason: null};
                value.pending = null; value.gap = null;
            }
            if (value.rollback.status === 'complete') return {status: 'duplicate', recovery: structuredClone(value)};
            const height = Math.max(request.ancestor.blockNum, value.checkpoint.blockNum - request.maxBlocks);
            value.checkpoint = height === request.ancestor.blockNum ? request.ancestor : {blockNum: height, blockId: block(height).blockId};
            value.coverage.retainedBlocks = height - value.coverage.floor.blockNum;
            value.coverage.retainedBytes = value.coverage.retainedBlocks * 128;
            if (height === request.ancestor.blockNum) value.rollback.status = 'complete';
            return {status: value.rollback.status === 'complete' ? 'rolled-back' : 'in-progress', recovery: structuredClone(value)};},
        async query(view) {calls.push('query'); return {view, rows: []};},
    };
    return {adapter, applied, marked, calls, slots, rollbacks, failApply: () => {failApply = 1;}, failMark: () => {failMark = 1;}};
}
function recoverySource(source: Pick<import('../../src/indexer/projection/source.js').PortableProjectionSource, 'frame' | 'revalidate'>): Pick<import('../../src/indexer/projection/source.js').PortableProjectionSource,
    'frame' | 'revalidate' | 'planRecovery' | 'revalidateRecovery'> {
    return {...source, async planRecovery(retained, finality) {
        return {target: {blockNum: retained.recovery.checkpoint.blockNum + 32, blockId: 'f'.repeat(64)},
            reportedIrreversible: {blockNum: 0, blockId: zero}, finality, checkpointStatus: 'canonical',
            intents: {pending: retained.recovery.pending ? 'canonical' : 'absent', gap: retained.recovery.gap ? 'canonical' : 'absent'}, rollback: null};
    }, async revalidateRecovery() {}};
}
function stateReadSource(source: Pick<import('../../src/indexer/projection/source.js').PortableProjectionSource, 'open' | 'revalidate' | 'assertDefinition'>) {
    const issued = new WeakMap<object, any>();
    return {...source, async openState(checkpoint: any, finality: any) {
        const proof = await source.open(checkpoint), state = {checkpoint, target: checkpoint, reportedIrreversible: checkpoint, finality};
        issued.set(state, proof); return state;
    }, async assertState(state: any, selected: ProjectionDefinition) {
        const proof = issued.get(state);
        if (!proof) throw new Error('Unissued fixture source state');
        await source.revalidate(proof); await source.assertDefinition(proof, selected);
    }};
}
function input(height: number, selected: ProjectionDefinition, value: unknown = {owner: 'alice'}) {
    return {frame: {chainId, block: block(height), changes: [{contract: selected.source.contract, table: selected.source.table,
        scope: '', primaryKey: 'full:opaque:key:00', abiDeployment: selected.source.abiDeployment, abiSha256: selected.source.abiSha256,
        present: true, value}]}, proof: {} as any, evidence: {certificateId: 'certificate', commitId: 'commit', selectionId: 'selection',
        observationId: 'observation', observationDigest: 'digest', captureSha256: 'capture', frameSha256: 'frame'}};
}

test('production scheduling requires recovery capability before adapter initialization', async () => {
    const r = reference(); delete (r.adapter as any).retainedCheckpoints;
    await expect(PortableStateController.create({chainId, configuration: config(definition()), adapter: r.adapter,
        source: recoverySource({frame: async () => input(1, definition()), revalidate: async () => {}})})).rejects.toMatchObject({code: 'projection.capability-unavailable'});
    expect(r.calls).toEqual([]);
});

test('restart resumes checkpoint+1 rather than replaying beyond retained source receipts; transport retry repeats exact height', async () => {
    const r = reference(500), seen: number[] = [], progress: any[] = [], selected = definition(); r.failApply();
    const options = {chainId, configuration: config(selected), adapter: r.adapter, maximumFramesPerProjection: 1,
        source: recoverySource({frame: async (height: number) => {seen.push(height); return input(height, selected);}, revalidate: async () => {}}),
        onProgress: (value: any) => progress.push(value)};
    const worker = await PortableStateController.create(options);
    await worker.drain(); expect(r.applied).toHaveLength(0);
    await worker.drain(); expect(seen).toEqual([501, 501]); expect(r.applied[0].block.blockNum).toBe(501);
    await worker.stop();
    const replacement = await PortableStateController.create(options); await replacement.drain();
    expect(seen).toEqual([501, 501, 502]); expect(progress.at(-1).checkpoint.blockNum).toBe(502);
});

test('selected contract failure is durably incomplete while an independent lane progresses; recovery retries the original block', async () => {
    const r = reference(), first = definition('first'), other = definition('other'), seen: any[] = [];
    let invalid = true;
    const worker = await PortableStateController.create({chainId, configuration: config(first, other), adapter: r.adapter,
        maximumFramesPerProjection: 1, source: recoverySource({frame: async (height, selected) => {
            seen.push([selected.id, height]); return input(height, selected, invalid && selected.id === first.id ? {} : {owner: 'alice'});
        }, revalidate: async () => {}})});
    await worker.drain();
    const admitted = r.marked.filter(value => value.reason === 'Canonical projection source admitted; durable application is pending');
    expect(admitted.map(value => value.binding.projectionId)).toEqual(['first', 'other']);
    expect(r.marked.filter(value => !admitted.includes(value)).map(value => value.binding.projectionId)).toEqual(['first']);
    expect(r.applied.map(value => value.binding.projectionId)).toEqual(['other']);
    const restarted = await PortableStateController.create({chainId, configuration: config(first, other), adapter: r.adapter,
        maximumFramesPerProjection: 1, source: recoverySource({frame: async (height, selected) => {seen.push([selected.id, height]);
            return input(height, selected, {owner: 'alice'});}, revalidate: async () => {}})});
    invalid = false; await restarted.drain();
    expect(seen).toContainEqual(['first', 1]); expect(r.slots.get('first').checkpoint.blockNum).toBe(1);
    expect(r.slots.get('other').checkpoint.blockNum).toBe(2); expect(r.slots.get('first').pending).toBeNull();
});

test('missing/corrupt known source is fenced before any apply and failed incomplete durability is retried', async () => {
    const r = reference(), selected = definition(); r.failMark();
    const worker = await PortableStateController.create({chainId, configuration: config(selected), adapter: r.adapter,
        source: recoverySource({frame: async () => {throw new PortableProjectionFrameError(block(1), new Error('retained input missing'));}, revalidate: async () => {}})});
    await worker.drain(); expect(r.applied).toHaveLength(0); expect(r.marked).toHaveLength(0);
    await worker.drain(); expect(r.marked).toHaveLength(1); expect(r.slots.get(selected.id).checkpoint.blockNum).toBe(0);
});

test('stop during source resolution prevents any later apply and concurrent drains never duplicate work', async () => {
    const r = reference(), selected = definition(), held = deferred(), entered = deferred();
    let frames = 0;
    const worker = await PortableStateController.create({chainId, configuration: config(selected), adapter: r.adapter,
        source: recoverySource({frame: async () => {frames++; entered.resolve(); await held.promise; return input(1, selected);}, revalidate: async () => {}})});
    const work = worker.drain(); await entered.promise; expect(worker.drain()).toBe(work);
    const stopped = worker.stop(); held.resolve(); await Promise.all([work, stopped]);
    expect(frames).toBe(1); expect(r.applied).toHaveLength(0);
});

test('production restart resumes the original durable rollback before asking for a newer canonical plan', async () => {
    const r = reference(), selected = definition();
    let fork = false, planned = 0;
    const source = recoverySource({frame: async height => input(height, selected), revalidate: async () => {}});
    const ordinaryPlan = source.planRecovery;
    source.planRecovery = async (retained, finality) => {
        planned++;
        if (!fork) return ordinaryPlan(retained, finality);
        expect(retained.checkpoints.map(point => point.blockNum)).toEqual([5, 4, 3, 2, 1, 0]);
        return {target: {blockNum: 5, blockId: block(5).blockId}, reportedIrreversible: {blockNum: 2, blockId: block(2).blockId},
            finality, checkpointStatus: 'orphaned', intents: {pending: 'absent', gap: 'absent'},
            rollback: {ancestor: {blockNum: 2, blockId: block(2).blockId}, reason: 'orphaned-checkpoint'}};
    };
    const options = {chainId, configuration: config(selected), adapter: r.adapter, source, maximumFramesPerProjection: 1};
    const worker = await PortableStateController.create(options);
    for (let count = 0; count < 5; count++) await worker.drain();
    fork = true; await worker.drain(); await worker.stop();
    expect(r.rollbacks).toHaveLength(1);
    const original = r.rollbacks[0], plannedBeforeRestart = planned;
    expect(original).toMatchObject({from: {blockNum: 5}, ancestor: {blockNum: 2}, revision: 'd'.repeat(64)});
    const restarted = await PortableStateController.create(options);
    await restarted.drain(); await restarted.drain(); await restarted.stop();
    expect(r.rollbacks).toEqual([original, original, original]);
    expect(planned).toBe(plannedBeforeRestart);
    expect(r.slots.get(selected.id).checkpoint.blockNum).toBe(2);
    expect(r.slots.get(selected.id).rollback.status).toBe('complete');
});

test('a source generation change before early admission cannot mark or apply a frame under the old plan', async () => {
    const r = reference(), selected = definition();
    let revoked = false;
    const source = recoverySource({frame: async (height, _definition, admit) => {
        revoked = true; await admit!(block(height)); return input(height, selected);
    }, revalidate: async () => {}});
    source.revalidateRecovery = async () => {if (revoked) throw new Error('Captured source generation retired');};
    const worker = await PortableStateController.create({chainId, configuration: config(selected), adapter: r.adapter,
        source, maximumFramesPerProjection: 1});
    await worker.drain(); await worker.stop();
    expect(r.marked).toHaveLength(0); expect(r.applied).toHaveLength(0); expect(r.rollbacks).toHaveLength(0);
    expect(r.slots.get(selected.id).checkpoint.blockNum).toBe(0);
});

test('canonical gate refuses checkpoint0 and forged contexts, initializes nothing, and fences late authority or checkpoint changes', async () => {
    const r = reference(), selected = definition(), configuration = config(selected);
    const {portableStateBinding} = await import('../../src/indexer/projection/config.js');
    const binding = portableStateBinding(configuration, selected, chainId);
    await r.adapter.initialize(selected, binding, {blockNum: 0, blockId: zero}); r.calls.length = 0;
    let revoked = false, opens = 0;
    const gate = createPortableStateReadGate({chainId, configuration, adapter: r.adapter,
        source: stateReadSource({open: async () => {opens++; return {} as any;}, assertDefinition: async () => {},
            revalidate: async () => {if (revoked) throw new Error('source revoked');}})});
    await expect(gate.readReady(selected.id)).rejects.toMatchObject({code: 'projection.incomplete'}); expect(opens).toBe(0);
    r.slots.get(selected.id).checkpoint = {blockNum: 1, blockId: block(1).blockId};
    const context = await gate.readReady(selected.id);
    await expect(gate.assertCurrent({...context})).rejects.toMatchObject({code: 'projection.stale-view'});
    revoked = true; await expect(gate.assertCurrent(context)).rejects.toThrow('source revoked');
    revoked = false; r.slots.get(selected.id).checkpoint = {blockNum: 2, blockId: block(2).blockId};
    await expect(gate.assertCurrent(context)).rejects.toMatchObject({code: 'projection.stale-view'});
    expect(r.calls).not.toContain('initialize'); expect(r.calls).not.toContain('query');
});

test('pre-deployment ABI refuses public queries and a no-row ABI change during a query cannot publish a last-valid result', async () => {
    const r = reference(2), selected = definition(), configuration = config(selected);
    const {portableStateBinding} = await import('../../src/indexer/projection/config.js');
    const binding = portableStateBinding(configuration, selected, chainId);
    await r.adapter.initialize(selected, binding, {blockNum: 0, blockId: zero});
    let deployed = false, changedDuringQuery = false;
    const gate = createPortableStateReadGate({chainId, configuration, adapter: r.adapter, source: stateReadSource({
        open: async () => ({} as any), revalidate: async () => {}, assertDefinition: async () => {
            if (!deployed || changedDuringQuery) throw new ProjectionContractError('projection.incomplete', 'ABI epoch unavailable');
        },
    })});
    const service = createPortableStateQueryService({chainId, configuration, adapter: r.adapter, gate});
    await expect(service.query(selected.id, {filter: [], limit: 1})).rejects.toMatchObject({statusCode: 503});
    expect(r.calls).not.toContain('query');
    deployed = true;
    expect((await service.query(selected.id, {filter: [], limit: 1})).view.checkpoint.blockNum).toBe(2);
    r.adapter.query = async view => {changedDuringQuery = true; return {view, rows: [{key: 'old', value: {owner: 'alice'}}]};};
    await expect(service.query(selected.id, {filter: [], limit: 1})).rejects.toMatchObject({statusCode: 503, retryable: true});
    expect(r.slots.get(selected.id).checkpoint.blockNum).toBe(2); // No row/checkpoint movement concealed the new ABI.
});
