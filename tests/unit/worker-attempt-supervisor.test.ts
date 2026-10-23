import {expect, it} from 'bun:test';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd, type AcceptedWorkerAttemptEnd}
    from '../../src/indexer/protocol/worker-attempt-supervisor.js';
import {WorkerAttemptClient, createControlledLocalAttemptClient} from '../../src/indexer/protocol/worker-attempt-client.js';
import {HyperionWorker} from '../../src/indexer/workers/hyperionWorker.js';
import {ProofConsumerScope} from '../../src/indexer/protocol/proof-consumer-scope.js';
import {PortableStateController} from '../../src/indexer/projection/controller.js';
import {resolvePortableStateConfiguration} from '../../src/indexer/projection/config.js';
import {PROJECTION_CAPABILITIES} from '@eosrio/hyperion-sdk/projection';

const descriptor = () => ({kind: 'source-delivery' as const, receiptId: randomUUID(), payloadSha256: '1'.repeat(64), headersSha256: '2'.repeat(64),
    consumerId: randomUUID(), publisherId: randomUUID(), queue: 'fixture:source', deliveryTag: 1});
function connection(supervisor: WorkerAttemptSupervisor) {
    const parent = new EventEmitter() as any, child = new EventEmitter() as any;
    parent.id = 1; parent.isConnected = () => true;
    parent.send = (message: any, callback: any) => {child.emit('message', structuredClone(message)); callback?.(null);};
    child.send = (message: any, callback: any) => {parent.emit('message', structuredClone(message)); callback?.(null);};
    supervisor.attach(parent, 'deserializer');
    return {physical: parent, client: new WorkerAttemptClient({mode: 'managed', role: 'deserializer', transport: child, timeoutMs: 20, retries: 0})};
}

it('authenticates the exact physical owner and ends only after its held root finalizer', async () => {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
    const first = connection(supervisor), replacement = connection(supervisor);
    let release!: () => void; const held = new Promise<void>(yes => {release = yes;});
    const handle = first.client.capture(descriptor());
    const work = first.client.run(handle, async () => {first.client.markAcknowledgementAttempt(); await held;});
    await turn(); expect(ends).toHaveLength(0); expect(supervisor.snapshot().active).toBe(1);
    await expect(replacement.client.run(handle, async () => {})).rejects.toThrow('Unissued');
    expect(ends).toHaveLength(0); release(); await work;
    expect(ends).toHaveLength(1); expect(describeWorkerAttemptEnd(supervisor, ends[0])).toMatchObject({status: 'quiescent', acknowledgementAttempted: true, rootResult: 'returned'});
    expect(() => describeWorkerAttemptEnd(supervisor, {} as any)).toThrow('Unissued');
    expect(supervisor.snapshot().active).toBe(0); first.client.dispose(); replacement.client.dispose();
});

it('keeps controlled local scopes explicitly without a master accepted end', async () => {
    const client = createControlledLocalAttemptClient('deserializer'), handle = client.capture(descriptor());
    await client.run(handle, () => 7);
    expect(client.describe(handle)).toMatchObject({mode: 'controlled-local-only', masterEnd: null, scope: {state: 'drained'}});
    client.dispose();
});

it('retains a non-draining fenced root until exact observed process exit, never a kill call or logical replacement', async () => {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end), fenceTimeoutMs: 10});
    const first = connection(supervisor); let killed = 0; first.physical.kill = () => {killed++;};
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(yes => {entered = yes;}), held = new Promise<void>(yes => {release = yes;});
    const handle = first.client.capture(descriptor());
    const work = first.client.run(handle, async () => {entered(); await held;}); void work.catch(() => {});
    await started; supervisor.fenceActive();
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(killed).toBeGreaterThan(0); expect(ends).toHaveLength(0); expect(supervisor.snapshot().active).toBe(1);
    const replacement = connection(supervisor); replacement.physical.emit('exit');
    expect(ends).toHaveLength(0); expect(supervisor.snapshot().active).toBe(1);
    first.physical.emit('exit');
    expect(describeWorkerAttemptEnd(supervisor, ends[0])).toMatchObject({status: 'process-exited-unresolved',
        acknowledgementAttempted: null, rootResult: 'unknown'});
    release(); await Promise.allSettled([work]); first.client.dispose(); replacement.client.dispose();
});

it('retains a physical receipt whose bounded header snapshot is unavailable and never enters proof processing', async () => {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
    const physical = connection(supervisor), worker = Object.create(HyperionWorker.prototype) as any;
    const consumer = new EventEmitter(), publisher = new EventEmitter();
    Object.assign(worker, {ch: consumer, cch: publisher, ch_ready: true, cch_ready: true});
    worker.configureWorkerAttemptLifecycle(physical.client);
    const message = {content: Buffer.from('original malformed-header custody'), fields: {deliveryTag: 1},
        properties: {headers: {large: Buffer.alloc(70 * 1024)}}};
    expect(() => worker.captureWorkerAttemptDelivery(message, consumer, 'source-delivery')).not.toThrow();
    let processed = false;
    await expect(worker.runWorkerAttemptDelivery(message, () => {processed = true;})).rejects.toThrow('header snapshot is unavailable');
    expect(processed).toBe(false); expect(ends).toHaveLength(1);
    expect(describeWorkerAttemptEnd(supervisor, ends[0])).toMatchObject({descriptor: {headersSha256: null},
        acknowledgementAttempted: false, rootResult: 'threw'});
    physical.client.dispose(); physical.physical.emit('exit');
});

it('fences a held projection initialization before a following definition can start', async () => {
    const chainId = 'c'.repeat(64), initialized: string[] = [];
    const definition = (id: string) => ({schemaVersion: 1 as const, id, mappingRevision: 'a'.repeat(64),
        source: {contract: 'items', table: id, abiDeployment: 'original-source-epoch', abiSha256: 'b'.repeat(64)},
        fields: [{name: 'owner', path: ['owner'], type: 'string' as const}], initialization: {kind: 'genesis' as const}});
    const configuration = resolvePortableStateConfiguration({backend: {kind: 'mongodb', id: 'fixture', database: 'fixture'},
        projections: [definition('first'), definition('second')]}, chainId)!;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(yes => {enter = yes;}), held = new Promise<void>(yes => {release = yes;});
    const adapter: any = {capabilities: {interfaceVersion: 1, supported: [...PROJECTION_CAPABILITIES]},
        async initialize(definition: any) {initialized.push(definition.id); if (definition.id === 'first') {enter(); await held;}},
        recovery: async () => {}};
    const scope = new ProofConsumerScope('projection-initialization-control');
    const work = scope.run(() => PortableStateController.create({chainId, configuration, adapter,
        source: {frame: async () => {throw new Error('No canonical source in this controlled initialization');}, revalidate: async () => {}}}));
    void work.catch(() => {}); await entered; scope.fence(); release();
    await expect(work).rejects.toThrow('Original worker attempt'); await scope.closeAndDrain();
    expect(initialized).toEqual(['first']);
});

it('does not dispatch a projection marker or apply after a held source revalidation loses its attempt', async () => {
    const chainId = 'c'.repeat(64), effects: string[] = [], selected = {schemaVersion: 1 as const, id: 'items', mappingRevision: 'a'.repeat(64),
        source: {contract: 'items', table: 'items', abiDeployment: 'original-source-epoch', abiSha256: 'b'.repeat(64)},
        fields: [{name: 'owner', path: ['owner'], type: 'string' as const}], initialization: {kind: 'genesis' as const}};
    const configuration = resolvePortableStateConfiguration({backend: {kind: 'mongodb', id: 'fixture', database: 'fixture'}, projections: [selected]}, chainId)!;
    let enter!: () => void, release!: () => void, binding: any;
    const entered = new Promise<void>(yes => {enter = yes;}), held = new Promise<void>(yes => {release = yes;});
    const adapter: any = {capabilities: {interfaceVersion: 1, supported: [...PROJECTION_CAPABILITIES]},
        async initialize(_definition: any, value: any) {binding = value;},
        async recovery() {return {binding, initialized: true, checkpoint: {blockNum: 0, blockId: '0'.repeat(64)}, pending: null, gap: null};},
        async markIncomplete() {effects.push('mark');}, async apply() {effects.push('apply');}};
    const controller = await PortableStateController.create({chainId, configuration, adapter, maximumFramesPerProjection: 1,
        source: {async frame() {return {frame: {chainId, block: {blockNum: 1, blockId: '1'.repeat(64), previousBlockId: '0'.repeat(64)}, changes: []},
            proof: {} as any, evidence: {} as any};}, async revalidate() {enter(); await held;}}});
    const scope = new ProofConsumerScope('projection-frame-control'), work = scope.run(() => controller.drain());
    void work.catch(() => {}); await entered; scope.fence(); release();
    await expect(work).rejects.toThrow('Original worker attempt'); await scope.closeAndDrain();
    expect(effects).toEqual([]); await controller.stop();
});
