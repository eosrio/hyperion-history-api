import {expect, it} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {issueFreshActionWrite} from '../../src/indexer/history/action-fresh-write.js';
import {actionHistoryImmutableJson} from '../../src/indexer/history/action-history-manifest.js';
import {ActionSourceAdmissionStore} from '../../src/indexer/history/action-source-admission.js';
import {ImmutableProtocolBundleStore} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {WorkerAttemptClient} from '../../src/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd, workerAttemptBounds,
    type AcceptedWorkerAttemptEnd} from '../../src/indexer/protocol/worker-attempt-supervisor.js';

const descriptor = () => ({kind: 'source-delivery' as const, receiptId: randomUUID(),
    payloadSha256: '1'.repeat(64), headersSha256: '2'.repeat(64), consumerId: randomUUID(),
    publisherId: randomUUID(), queue: 'fixture:source', deliveryTag: 1});

function connection(supervisor: WorkerAttemptSupervisor, options: {dropFirstObservationReply?: boolean} = {}) {
    const physical = new EventEmitter() as EventEmitter & {isConnected: () => boolean;
        send: (message: any, callback?: (error: Error | null) => void) => void};
    const transport = new EventEmitter() as EventEmitter & {send: (message: any, callback?: (error: Error | null) => void) => void};
    const requests: any[] = [], replies: any[] = [];
    let dropped = false;
    physical.isConnected = () => true;
    physical.send = (message, callback) => {
        replies.push(structuredClone(message));
        if (options.dropFirstObservationReply && !dropped && message.event === 'worker_attempt_reply'
            && Object.hasOwn(message.result, 'accepted')) dropped = true;
        else transport.emit('message', structuredClone(message));
        callback?.(null);
    };
    transport.send = (message, callback) => {
        requests.push(structuredClone(message)); physical.emit('message', structuredClone(message)); callback?.(null);
    };
    supervisor.attach(physical, 'deserializer');
    return {physical, client: new WorkerAttemptClient({mode: 'managed', role: 'deserializer', transport,
        timeoutMs: 30, retries: 1}), requests, replies};
}

const bundles = new ImmutableProtocolBundleStore(frontierMemoryClient().client as any, 'fresh-ipc-fixture', 0,
    'action-source-admission', 'history-source-admission-v1');
async function issued(ordinal: number, kind: 'confirmed-handoff' | 'attempt-disposition' = 'attempt-disposition', idDigit?: string,
                      recordOrdinal = ordinal) {
    const id = (kind === 'confirmed-handoff' ? 'h45actionhandoff1:' : 'h45actionattempt1:')
        + (idDigit ?? ordinal.toString(16).padStart(64, '0'));
    const result = {id, observation: {ordinal}}, record = {disposition: 'no-effects',
        work: {stage: 'main-source', ordinal: recordOrdinal}, ordinal: recordOrdinal};
    const proof = await bundles.prepare(id, {schemaVersion: 1, payloadJson: actionHistoryImmutableJson(record)});
    return issueFreshActionWrite(result, kind, id, record, proof, bundles);
}

it('joins only fresh writes from the original physical receipt; copies and another worker cannot borrow them', async () => {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
    const first = connection(supervisor), other = connection(supervisor), handle = first.client.capture(descriptor());
    await first.client.run(handle, async () => {
        await first.client.bindCurrent({selectionId: 'h45srcsel1:' + 'a'.repeat(64)});
        const result = await issued(1, 'confirmed-handoff');
        await expect(first.client.observeFreshActionWrite(structuredClone(result))).rejects.toThrow('fresh result');
        expect(await first.client.observeFreshActionWrite(result)).toBe(true);
        const observe = first.requests.find(message => message.payload?.operation === 'observe');
        expect(observe).toBeDefined();
        supervisor.handle(other.physical, structuredClone(observe));
        expect(other.replies.at(-1)?.result?.ok).toBe(false);
        first.client.markAcknowledgementAttempt();
    });
    expect(ends).toHaveLength(1);
    const end = describeWorkerAttemptEnd(supervisor, ends[0]);
    expect(end).toMatchObject({status: 'quiescent', rootResult: 'returned', acknowledgementAttempted: true,
        freshWriteOverflow: false, binding: {selectionId: 'h45srcsel1:' + 'a'.repeat(64)}});
    expect(end.freshWrites).toHaveLength(1);
    expect(end.freshWrites[0]).toMatchObject({kind: 'confirmed-handoff', id: 'h45actionhandoff1:' + '1'.padStart(64, '0')});
    expect(supervisor.snapshot().owners[0].attempts[0]).not.toHaveProperty('freshWrites');
    expect(() => describeWorkerAttemptEnd(supervisor, structuredClone(ends[0]))).toThrow('Unissued');
    first.client.dispose(); other.client.dispose();
});

it('retries the exact observation request without counting a second write', async () => {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
    const link = connection(supervisor, {dropFirstObservationReply: true}), handle = link.client.capture(descriptor());
    await link.client.run(handle, async () => {expect(await link.client.observeFreshActionWrite(await issued(2))).toBe(true);});
    const attempts = link.requests.filter(message => message.payload?.operation === 'observe');
    expect(attempts).toHaveLength(2);
    expect(attempts[0].requestId).toBe(attempts[1].requestId);
    expect(describeWorkerAttemptEnd(supervisor, ends[0]).freshWrites).toHaveLength(1);
    link.client.dispose();
});

it('marks a per-attempt evidence budget overflow without interrupting its ordinary root or ACK attempt', async () => {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
    const link = connection(supervisor), handle = link.client.capture(descriptor());
    let accepted = 0, overflow = 0;
    await link.client.run(handle, async () => {
        for (let ordinal = 1; ordinal <= workerAttemptBounds.maximumFreshWritesPerAttempt + 2; ordinal++) {
            if (await link.client.observeFreshActionWrite(await issued(ordinal))) accepted++;
            else overflow++;
        }
        link.client.markAcknowledgementAttempt();
    });
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThanOrEqual(workerAttemptBounds.maximumFreshWritesPerAttempt);
    expect(overflow).toBe(workerAttemptBounds.maximumFreshWritesPerAttempt + 2 - accepted);
    expect(overflow).toBeGreaterThan(0);
    const end = describeWorkerAttemptEnd(supervisor, ends[0]);
    expect(end).toMatchObject({status: 'quiescent', rootResult: 'returned', acknowledgementAttempted: true,
        freshWriteOverflow: true});
    expect(end.freshWrites).toHaveLength(accepted);
    const next = link.client.capture(descriptor());
    await link.client.run(next, async () => {expect(await link.client.observeFreshActionWrite(await issued(500))).toBe(true);});
    expect(describeWorkerAttemptEnd(supervisor, ends[1])).toMatchObject({freshWriteOverflow: false});
    expect(describeWorkerAttemptEnd(supervisor, ends[1]).freshWrites).toHaveLength(1);
    link.client.dispose();
});

it('rejects conflicting results for one original work while retaining only its first fresh write', async () => {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
    const link = connection(supervisor), handle = link.client.capture(descriptor());
    await expect(link.client.run(handle, async () => {
        expect(await link.client.observeFreshActionWrite(await issued(1))).toBe(true);
        const conflict = await issued(999, 'attempt-disposition', undefined, 1);
        await link.client.observeFreshActionWrite(conflict);
    })).rejects.toThrow('Conflicting fresh action work');
    expect(describeWorkerAttemptEnd(supervisor, ends[0])).toMatchObject({rootResult: 'threw', freshWriteOverflow: false});
    expect(describeWorkerAttemptEnd(supervisor, ends[0]).freshWrites).toHaveLength(1);
    link.client.dispose();
});

it('retains a restart-readable private observation without reissuing the original end', async () => {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
    const link = connection(supervisor), handle = link.client.capture(descriptor());
    await link.client.run(handle, async () => {
        expect(await link.client.observeFreshActionWrite(await issued(88))).toBe(true);
        link.client.markAcknowledgementAttempt();
    });
    const memory = frontierMemoryClient();
    const store = new ActionSourceAdmissionStore(memory.client as any, 'association-restart-fixture', 0);
    const writeId = describeWorkerAttemptEnd(supervisor, ends[0]).freshWrites[0].id;
    const input = {sourceChecked: true, results: [{id: writeId, classification: 'intentional-no-effect' as const}]};
    await expect(store.recordAttemptAssociation(supervisor, ends[0], {sourceChecked: true,
        results: [{id: writeId, classification: 'confirmed-handoff'}]})).rejects.toThrow('Invalid bounded');
    await expect(store.recordAttemptAssociation(supervisor, ends[0], {sourceChecked: true,
        results: [{id: writeId, classification: 'contract-incomplete'}]})).rejects.toThrow('Invalid bounded');
    const retained = await store.recordAttemptAssociation(supervisor, ends[0], input);
    const reopened = new ActionSourceAdmissionStore(memory.client as any, 'association-restart-fixture', 0);
    const observation = await reopened.readAttemptAssociation(retained.id);
    expect(observation.observation).toEqual(retained.observation);
    expect(observation.observation.brokerSettlement).toBe('unknown');
    await expect(store.recordAttemptAssociation(supervisor, structuredClone(ends[0]), input)).rejects.toThrow('Unissued');
    link.client.dispose();
});
