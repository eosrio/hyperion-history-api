import {expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {serialize} from 'node:v8';
import {WorkerProofDemandObserver, ActionProofDemandEnrollment} from '../../src/indexer/history/action-proof-demand-enrollment.js';
import {ActionProofDemandShadow} from '../../src/indexer/history/action-proof-demand.js';
import {ActionAttemptAdjudicator} from '../../src/indexer/history/action-attempt-adjudicator.js';
import {WorkerAttemptSupervisor, consumeWorkerAttemptObservation, type WorkerAttemptObservation} from '../../src/indexer/protocol/worker-attempt-supervisor.js';
import {HyperionWorker} from '../../src/indexer/workers/hyperionWorker.js';
import {WorkerAttemptClient} from '../../src/indexer/protocol/worker-attempt-client.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const source = {chainId: 'a'.repeat(64), blockNum: 33, blockId: 'b'.repeat(64), previousBlockId: 'c'.repeat(64),
    selectionId: 'h45srcsel1:' + 'd'.repeat(64)};
const observed = {source, admissionId: 'h45actionadmission1:' + 'e'.repeat(64), traceOrdinal: 0};
const fields = {admissionId: observed.admissionId, traceOrdinal: 0, blockNum: source.blockNum, blockId: source.blockId,
    selectionId: source.selectionId, configurationSha256: 'f'.repeat(64), targetName: 'fixture-action', targetUuid: 'fixture-uuid'};
const payload = Buffer.from('original-dispatch'), headers = {block_num: 33, typed: Buffer.from('original-header')};

function setup(options: {holdPacket?: 'capture' | 'binding'; observerThrows?: boolean; accountingCount?: number; endObserverThrows?: boolean; supervisorThrows?: boolean} = {}) {
    const peer = new EventEmitter() as any, transport = new EventEmitter() as any;
    let enrollment: ActionProofDemandEnrollment, savedToken: WorkerAttemptObservation | undefined;
    const supervisor = new WorkerAttemptSupervisor({onObservation: token => {
        savedToken = token;
        if (options.supervisorThrows) throw new Error('constructed lifecycle observer failure');
        // Consume only the ended observation in this fault control; original root/end still succeeds.
        if (options.endObserverThrows && supervisor.snapshot().active === 0) {
            consumeWorkerAttemptObservation(supervisor, token); throw new Error('constructed ended observer failure');
        }
        enrollment.observe(token);
    }});
    peer.isConnected = () => true;
    peer.send = (message: unknown, callback?: (error: Error | null) => void) => {transport.emit('message', structuredClone(message)); callback?.(null);};
    transport.send = (message: unknown, callback?: (error: Error | null) => void) => {peer.emit('message', structuredClone(message)); callback?.(null);};
    supervisor.attach(peer, 'ds_pool_worker');
    const client = new WorkerAttemptClient({mode: 'managed', role: 'ds_pool_worker', transport, timeoutMs: 100, retries: 0});
    const adjudicator = new ActionAttemptAdjudicator(supervisor, {} as any, {} as any, {} as any);
    const accounting = new ActionProofDemandShadow(adjudicator, {maximumDemands: options.accountingCount ?? 8, maximumBytes: 65536});
    enrollment = new ActionProofDemandEnrollment(supervisor, accounting);
    const held: string[] = [];
    const observer = new WorkerProofDemandObserver((packet, done) => {
        if (options.observerThrows) throw new Error('constructed diagnostic transport failure');
        if (JSON.parse(packet).type === options.holdPacket) held.push(packet); else enrollment.receive(peer, packet);
        done();
    });
    let release!: () => void, entered!: () => void;
    const heldOperation = new Promise<void>(yes => {release = yes;}), entry = new Promise<void>(yes => {entered = yes;});
    const receiptId = randomUUID();
    const handle = client.capture({kind: 'ds-delivery', receiptId, payloadSha256: hash(payload), headersSha256: hash(serialize(headers)),
        consumerId: randomUUID(), publisherId: randomUUID(), queue: 'fixture:ds', deliveryTag: 1});
    observer.capture(receiptId, payload, headers);
    const run = client.run(handle, async () => {await client.bindCurrent(fields); observer.bound(receiptId, observed); entered(); await heldOperation; return 'original-result';});
    return {supervisor, client, accounting, enrollment, observer, receiptId, peer, held, entry, run, release,
        token: () => savedToken!, close() {client.dispose(); supervisor.observeExit(peer);}};
}

test('receipt bytes remain visible before source binding and transfer without a coverage gap', async () => {
    const value = setup();
    try {
        const queued = value.enrollment.snapshot();
        expect(queued).toMatchObject({receiptCustodyCount: 1, unboundCustodyCount: 1, coverage: 'incomplete', canonicalAuthority: false,
            retainedCaptureBytes: payload.length + serialize(headers).length, semanticCustodyKnownBytesLowerBound: payload.length + serialize(headers).length,
            accounting: {retainedDemands: 0}, receipts: [{phase: 'receipt-process-custody', owner: null, sourceClaim: null}]});
        await value.entry;
        expect(value.enrollment.snapshot()).toMatchObject({receiptCustodyCount: 1, unboundCustodyCount: 0, canonicalAuthority: false,
            semanticCustodyKnownBytesLowerBound: queued.semanticCustodyKnownBytesLowerBound,
            receipts: [{phase: 'child-binding-observed', enrolled: true}], accounting: {pendingDemands: 1, resolvedDemands: 0}});
        value.release(); expect(await value.run).toBe('original-result');
        expect(value.enrollment.snapshot()).toMatchObject({receipts: [{ended: true}], accounting: {pendingDemands: 1, resolvedDemands: 0}});
    } finally {value.release(); await value.run.catch(() => {}); value.close();}
});

for (const holdPacket of ['capture','binding'] as const)
    test(`late ${holdPacket} after an original genuine end retains uncertainty without reconstruction`, async () => {
        const value = setup({holdPacket});
        try {
            await value.entry; value.release(); expect(await value.run).toBe('original-result');
            expect(value.accounting.snapshot().retainedDemands).toBe(0);
            value.enrollment.receive(value.peer, value.held[0]);
            expect(value.enrollment.snapshot()).toMatchObject({late: 1, coverage: 'incomplete', unboundCustodyCount: 1,
                semanticCustodyKnownBytesLowerBound: payload.length + serialize(headers).length,
                receipts: [{ended: true, enrolled: false, unavailable: true}], accounting: {retainedDemands: 0}});
            value.enrollment.observe(value.token());
            expect(value.enrollment.snapshot().failures).toBeGreaterThan(0);
        } finally {value.release(); await value.run.catch(() => {}); value.close();}
    });

test('unknown or throwing diagnostic transport cannot alter the original managed result', async () => {
    const value = setup({observerThrows: true});
    try {
        await value.entry; value.release(); expect(await value.run).toBe('original-result');
        expect(value.observer.snapshot()).toMatchObject({knownCapturedPayloadBytes: payload.length, failures: 2});
        expect(value.observer.snapshot().reservedEncodedCopyBytes).toBeGreaterThan(0);
        expect(value.enrollment.snapshot()).toMatchObject({coverage: 'incomplete', unknownCapturedPayloads: 1,
            accounting: {retainedDemands: 0}, receipts: [{ended: true, enrolled: false}]});
    } finally {value.release(); await value.run.catch(() => {}); value.close();}
});

test('a failed ended observation cannot let late capture reconstruct an expired original lifecycle', async () => {
    const value = setup({holdPacket: 'capture', endObserverThrows: true});
    try {
        await value.entry; value.release(); expect(await value.run).toBe('original-result');
        expect(value.supervisor.observationSnapshot().failures).toBe(1);
        value.enrollment.receive(value.peer, value.held[0]);
        expect(value.enrollment.snapshot()).toMatchObject({coverage: 'incomplete', unboundCustodyCount: 1,
            semanticCustodyKnownBytesLowerBound: payload.length + serialize(headers).length,
            receipts: [{enrolled: false, unavailable: true}], accounting: {retainedDemands: 0}});
    } finally {value.release(); await value.run.catch(() => {}); value.close();}
});

test('throwing registration/binding/end observations preserve original lifecycle outcomes', async () => {
    const value = setup({supervisorThrows: true});
    try {
        await value.entry; value.release(); expect(await value.run).toBe('original-result');
        expect(value.supervisor.snapshot()).toMatchObject({active: 0, overflow: false});
        expect(value.supervisor.observationSnapshot().failures).toBe(3);
        expect(value.enrollment.snapshot()).toMatchObject({coverage: 'incomplete', receiptCustodyCount: 1,
            unboundCustodyCount: 1, receipts: [{owner: null, enrolled: false}], accounting: {retainedDemands: 0}});
    } finally {value.release(); await value.run.catch(() => {}); value.close();}
});

test('missing original headers leave known input bytes charged', async () => {
    const value = setup({holdPacket: 'capture'});
    try {
        await value.entry;
        const packet = JSON.parse(value.held[0]); packet.headersHex = null;
        value.enrollment.receive(value.peer, JSON.stringify(packet));
        expect(value.enrollment.snapshot()).toMatchObject({retainedCaptureBytes: payload.length, coverage: 'incomplete',
            accounting: {pendingDemands: 1, knownPendingBytes: payload.length, unknownPendingHeaders: 1, accounting: 'incomplete'}});
    } finally {value.release(); await value.run.catch(() => {}); value.close();}
});

test('a saturated source ledger preserves captured input uncertainty and the known lower bound', async () => {
    const value = setup({holdPacket: 'capture', accountingCount: 1});
    try {
        await value.entry;
        value.accounting.retain({...observed, owner: {epoch: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID()},
            payload, headers, stage: 'retained-copy', copyId: 'other-owned-copy'});
        value.enrollment.receive(value.peer, value.held[0]);
        expect(value.enrollment.snapshot()).toMatchObject({coverage: 'incomplete', unboundCustodyCount: 1,
            retainedCaptureBytes: payload.length + serialize(headers).length, receipts: [{enrolled: false, unavailable: true}],
            accounting: {retainedDemands: 1, omittedDemands: 1, pendingDemands: 1, resolvedDemands: 0}});
        expect(value.enrollment.snapshot().semanticCustodyKnownBytesLowerBound).toBe((payload.length + serialize(headers).length) * 2);
    } finally {value.release(); await value.run.catch(() => {}); value.close();}
});

for (const key of ['payloadHex','headersHex'])
    test(`overwritten captured ${key} cannot borrow the original registered digest`, async () => {
        const value = setup({holdPacket: 'capture'});
        try {
            await value.entry;
            const packet = JSON.parse(value.held[0]); packet[key] = '00';
            value.enrollment.receive(value.peer, JSON.stringify(packet));
            expect(value.enrollment.snapshot()).toMatchObject({coverage: 'incomplete', unboundCustodyCount: 1,
                receipts: [{enrolled: false, unavailable: true}], accounting: {retainedDemands: 0}});
            expect(value.enrollment.snapshot().semanticCustodyKnownBytesLowerBound).toBeGreaterThan(0);
            value.release(); expect(await value.run).toBe('original-result');
        } finally {value.release(); await value.run.catch(() => {}); value.close();}
    });

test('identical redelivered bytes on a different physical owner and selection remain separate', async () => {
    const value = setup(), peer = new EventEmitter() as any, transport = new EventEmitter() as any;
    peer.isConnected = () => true;
    peer.send = (message: unknown, callback?: (error: Error | null) => void) => {transport.emit('message', structuredClone(message)); callback?.(null);};
    transport.send = (message: unknown, callback?: (error: Error | null) => void) => {peer.emit('message', structuredClone(message)); callback?.(null);};
    value.supervisor.attach(peer, 'ds_pool_worker');
    const client = new WorkerAttemptClient({mode: 'managed', role: 'ds_pool_worker', transport, timeoutMs: 100, retries: 0});
    const observer = new WorkerProofDemandObserver((packet, done) => {value.enrollment.receive(peer, packet); done();});
    const receiptId = randomUUID(), selectionId = 'h45srcsel1:' + '2'.repeat(64);
    const handle = client.capture({kind: 'ds-delivery', receiptId, payloadSha256: hash(payload), headersSha256: hash(serialize(headers)),
        consumerId: randomUUID(), publisherId: randomUUID(), queue: 'fixture:ds', deliveryTag: 1});
    observer.capture(receiptId, payload, headers);
    const run = client.run(handle, async () => {await client.bindCurrent({...fields, selectionId});
        observer.bound(receiptId, {...observed, source: {...source, selectionId}}); return 'replacement-result';});
    try {
        await value.entry; expect(await run).toBe('replacement-result');
        const snapshot = value.enrollment.snapshot();
        expect(snapshot.accounting).toMatchObject({retainedDemands: 2, pendingDemands: 2, resolvedDemands: 0});
        expect(new Set(snapshot.receipts.map(entry => entry.owner?.incarnation)).size).toBe(2);
        expect(new Set(snapshot.receipts.map(entry => entry.sourceClaim?.source.selectionId)).size).toBe(2);
    } finally {value.release(); await value.run.catch(() => {}); await run.catch(() => {}); value.close(); client.dispose(); value.supervisor.observeExit(peer);}
});

for (const overwrite of ['payload','headers'])
    test(`overwriting original queued ${overwrite} keeps the original entry guard and captured custody`, async () => {
        const value = setup();
        try {
            await value.entry;
            const worker = Object.create(HyperionWorker.prototype);
            worker.configureWorkerAttemptLifecycle(value.client); worker.ch = value.peer;
            worker.cch = new EventEmitter(); worker.ch_ready = true; worker.cch_ready = true;
            worker.configureProofDemandObserver(value.observer);
            const message = {content: Buffer.from(payload), properties: {headers: structuredClone(headers)}, fields: {deliveryTag: 2}};
            worker.captureWorkerAttemptDelivery(message, value.peer, 'ds-delivery');
            if (overwrite === 'payload') message.content[0] ^= 1; else message.properties.headers.block_num++;
            let entries = 0;
            await expect(worker.runWorkerAttemptDelivery(message, async () => {entries++;})).rejects.toThrow('Original queued worker attempt bytes/headers changed');
            expect(entries).toBe(0);
            expect(value.enrollment.snapshot()).toMatchObject({receiptCustodyCount: 2, unboundCustodyCount: 1, coverage: 'incomplete',
                accounting: {retainedDemands: 1, pendingDemands: 1, resolvedDemands: 0}});
            expect(value.enrollment.snapshot().receipts[1]).toMatchObject({ended: true, enrolled: false, payloadBytes: payload.length});
        } finally {value.release(); await value.run.catch(() => {}); value.close();}
    });

test('foreign/copy/expired lifecycle tokens and foreign physical senders never join custody', async () => {
    const value = setup();
    try {
        await value.entry;
        const before = value.enrollment.snapshot();
        value.enrollment.observe(structuredClone(value.token())); value.enrollment.observe(value.token());
        value.enrollment.receive({} as any, JSON.stringify({schemaVersion: 1, type: 'capture', receiptId: value.receiptId, payloadHex: '00', headersHex: null}));
        expect(value.enrollment.snapshot()).toMatchObject({failures: before.failures + 3,
            receiptCustodyCount: before.receiptCustodyCount, retainedCaptureBytes: before.retainedCaptureBytes,
            accounting: {pendingDemands: 1, resolvedDemands: 0}});
    } finally {value.release(); await value.run.catch(() => {}); value.close();}
});

test('payload/envelope and in-flight limits are checked before header getters or additional dispatch', () => {
    let reads = 0, calls = 0;
    const unavailable = Object.defineProperty({}, 'accessor', {enumerable: true, get() {reads++; throw new Error('must not execute');}});
    const observer = new WorkerProofDemandObserver(() => {calls++;}, {maximumReceipts: 2, maximumBytes: 65536 + 512});
    observer.capture(randomUUID(), Buffer.alloc(16384), unavailable);
    expect(reads).toBe(0); expect(calls).toBe(0);
    observer.capture(randomUUID(), payload, headers); observer.capture(randomUUID(), payload, unavailable);
    expect(reads).toBe(0); expect(calls).toBe(1);
    expect(observer.snapshot()).toMatchObject({receipts: 2, reservedEncodedCopyBytes: 65536, reservedMetadataBytes: 512,
        omittedKnownPayloadBytes: 16384, unknownOmittedHeaderCopies: 1, unknownHeaders: 1, omitted: 2});
});

test('observer window and configuration stay finite under mutation and unrelated getters', () => {
    let getterReads = 0;
    const input = Object.defineProperty({maximumReceipts: 1, maximumBytes: 1024 * 1024}, 'unrelated', {enumerable: true, get() {getterReads++; throw Error('unrelated');}});
    const packets: string[] = [], observer = new WorkerProofDemandObserver((packet, done) => {packets.push(packet); done();}, input);
    input.maximumReceipts = Infinity; input.maximumBytes = Infinity;
    observer.capture(randomUUID(), payload, headers); observer.capture(randomUUID(), payload, headers);
    expect(getterReads).toBe(0); expect(packets).toHaveLength(1);
    expect(observer.snapshot()).toMatchObject({receipts: 1, omitted: 1, limits: {maximumReceipts: 1, maximumBytes: 1024 * 1024}});
});

test('parent metadata/count and decode budgets omit new work without evicting retained custody', async () => {
    const value = setup();
    try {
        await value.entry;
        const packet = JSON.stringify({schemaVersion: 1, type: 'capture', receiptId: randomUUID(),
            payloadHex: payload.toString('hex'), headersHex: serialize(headers).toString('hex')});
        const parent = new ActionProofDemandEnrollment(value.supervisor, value.accounting, {maximumReceipts: 1, maximumBytes: 1024 * 1024});
        parent.receive(value.peer, packet); const before = parent.snapshot();
        parent.receive(value.peer, packet.replace(JSON.parse(packet).receiptId, randomUUID()));
        expect(parent.snapshot()).toMatchObject({receiptCustodyCount: 1, retainedCaptureBytes: before.retainedCaptureBytes,
            coverage: 'incomplete', omitted: 1});
        const byteBound = new ActionProofDemandEnrollment(value.supervisor, value.accounting, {maximumReceipts: 1, maximumBytes: 65536 + 128});
        byteBound.receive(value.peer, packet);
        expect(byteBound.snapshot()).toMatchObject({receiptCustodyCount: 1, retainedCaptureBytes: 0,
            unknownCapturedPayloads: 1, coverage: 'incomplete', omitted: 1, receipts: [{unavailable: true}]});
        byteBound.receive(value.peer, 'x'.repeat(16385));
        expect(byteBound.snapshot().failures).toBe(1);
    } finally {value.release(); await value.run.catch(() => {}); value.close();}
});

test('the optional capture hook does not add reads of original header accessors', async () => {
    const value = setup(); let reads = 0;
    try {
        await value.entry;
        const worker = Object.create(HyperionWorker.prototype);
        worker.configureWorkerAttemptLifecycle(value.client); worker.ch = value.peer;
        worker.cch = new EventEmitter(); worker.ch_ready = true; worker.cch_ready = true;
        worker.configureProofDemandObserver(value.observer);
        const message = {content: Buffer.from(payload), properties: Object.defineProperty({}, 'headers', {
            enumerable: true, get() {reads++; return headers;},
        }), fields: {deliveryTag: 2}};
        worker.captureWorkerAttemptDelivery(message, value.peer, 'ds-delivery');
        expect(reads).toBe(1);
        expect(await worker.runWorkerAttemptDelivery(message, async () => 'unchanged')).toBe('unchanged');
        expect(reads).toBe(2); // Original entry revalidation; diagnostics used descriptors and left headers unknown.
        expect(value.observer.snapshot().unknownHeaders).toBe(1);
    } finally {value.release(); await value.run.catch(() => {}); value.close();}
});
