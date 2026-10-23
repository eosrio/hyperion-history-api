import {expect, it} from 'bun:test';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd, type AcceptedWorkerAttemptEnd}
    from '../../src/indexer/protocol/worker-attempt-supervisor.js';
import {WorkerAttemptClient, createControlledLocalAttemptClient} from '../../src/indexer/protocol/worker-attempt-client.js';
import {currentProofConsumerScope} from '../../src/indexer/protocol/proof-consumer-scope.js';

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
