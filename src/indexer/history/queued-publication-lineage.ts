import {createHash, randomUUID} from 'node:crypto';
import {actionHistoryImmutableJson} from './action-history-manifest.js';
import type {PhysicalAttemptWorker, WorkerAttemptBinding, WorkerAttemptDescriptor, WorkerAttemptEndDescription} from '../protocol/worker-attempt-supervisor.js';

export interface QueuedPublicationData {
    queue: string; payloadSha256: string; payloadBytes: number; headersSha256: string; headersBytes: number; count: 1;
}
export interface QueuedPublicationOrigin {
    worker: PhysicalAttemptWorker; epoch: string; incarnation: string; attemptId: string;
    descriptor: WorkerAttemptDescriptor; binding: WorkerAttemptBinding; isCurrent: () => boolean;
}
export interface QueuedPublicationSource {
    chainId: string; generation: string; readerSessionId: string; isCurrent: () => boolean;
}
export interface QueuedPublicationOptions {
    maximumPublications: number; maximumDeliveries: number;
    source: (binding: Readonly<WorkerAttemptBinding>) => QueuedPublicationSource;
    consumerQueue: (worker: PhysicalAttemptWorker) => string | undefined;
}
const digest = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => actionHistoryImmutableJson(a, 16 * 1024) === actionHistoryImmutableJson(b, 16 * 1024);
const currentSource = (source: QueuedPublicationSource): boolean => {
    try {return source.isCurrent() === true;} catch {return false;}
};

/** MainDS required scalar headers only. No JSON conversion of opaque AMQP values or accessors. */
export function queuedPublicationData(queue: string, payload: Buffer, headers: unknown): QueuedPublicationData {
    if (!Buffer.isBuffer(payload) || !headers || typeof headers !== 'object' || Array.isArray(headers)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(headers))) throw new Error('Queued publication original bytes unavailable');
    if (['byteLength', 'byteOffset', 'buffer', 'length', 'constructor'].some(name => Object.hasOwn(payload, name)))
        throw new Error('Queued publication original byte layout unavailable');
    const captured: Record<string, string | number | boolean | null> = Object.create(null);
    const names = Object.keys(headers);
    if (names.length > 64) throw new Error('Queued publication header count exceeds bound');
    for (const name of names) {
        const property = Object.getOwnPropertyDescriptor(headers, name), value = property?.value;
        if (!property || !Object.hasOwn(property, 'value') || value !== null && !['string', 'number', 'boolean'].includes(typeof value))
            throw new Error('Queued publication header type unavailable');
        captured[name] = value;
    }
    const encoded = actionHistoryImmutableJson(captured, 64 * 1024);
    const value = {queue, payloadSha256: sha(payload), payloadBytes: payload.length,
        headersSha256: sha(encoded), headersBytes: Buffer.byteLength(encoded), count: 1 as const};
    validateQueuedPublicationData(value); return value;
}
export function validateQueuedPublicationData(value: QueuedPublicationData): void {
    if (!value || Object.keys(value).sort().join(',') !== 'count,headersBytes,headersSha256,payloadBytes,payloadSha256,queue'
        || typeof value.queue !== 'string' || !value.queue.length || value.queue.length > 255 || !value.queue.isWellFormed()
        || !digest.test(value.payloadSha256) || !digest.test(value.headersSha256) || value.count !== 1
        || !Number.isSafeInteger(value.payloadBytes) || value.payloadBytes < 1 || value.payloadBytes > 128 * 1024 * 1024
        || !Number.isSafeInteger(value.headersBytes) || value.headersBytes < 1 || value.headersBytes > 64 * 1024)
        throw new Error('Invalid original queued publication metadata');
}
interface Delivery {origin: QueuedPublicationOrigin; redelivered: boolean; end?: WorkerAttemptEndDescription['status'];}
interface Publication {
    messageId: string; requestId: string; origin: QueuedPublicationOrigin; data: QueuedPublicationData;
    source: QueuedPublicationSource; deliveries: Delivery[]; producerEnd?: WorkerAttemptEndDescription['status'];
}
/** Private bounded lineage custody, never a reader-credit allocator or broker-settlement oracle. */
export class QueuedPublicationLineage {
    private readonly publications = new Map<string, Publication>();
    private readonly requests = new Map<string, string>();
    private deliveryCount = 0;
    constructor(private readonly options: QueuedPublicationOptions) {
        if (![options.maximumPublications, options.maximumDeliveries].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 4096)
            || typeof options.source !== 'function' || typeof options.consumerQueue !== 'function')
            throw new Error('Invalid private queued-publication bounds');
        this.options = Object.freeze({...options});
    }
    issue(origin: QueuedPublicationOrigin, requestId: string, input: QueuedPublicationData): string {
        validateQueuedPublicationData(input);
        if (!origin.isCurrent() || origin.descriptor.kind !== 'source-delivery' || !origin.descriptor.consumerId || !origin.descriptor.publisherId
            || !origin.binding.selectionId || !origin.binding.admissionId || !origin.binding.readerSessionId
            || !origin.binding.blockNum || !origin.binding.blockId) throw new Error('Queued publication lacks its original bound producer');
        const previous = this.requests.get(requestId);
        if (previous) {
            const old = this.publications.get(previous)!;
            if (old.origin.worker !== origin.worker || old.origin.attemptId !== origin.attemptId || !same(old.data, input)
                || !currentSource(old.source)) throw new Error('Queued publication request changed');
            return previous;
        }
        if (this.publications.size >= this.options.maximumPublications) throw new Error('Queued publication lineage window exhausted');
        const source = this.options.source(Object.freeze({...origin.binding}));
        if (!source || !digest.test(source.chainId) || !uuid.test(source.generation) || source.readerSessionId !== origin.binding.readerSessionId
            || typeof source.isCurrent !== 'function' || !currentSource(source) || !origin.isCurrent())
            throw new Error('Queued publication source generation unavailable');
        const messageId = randomUUID();
        this.publications.set(messageId, {messageId, requestId, origin, data: {...input}, source: Object.freeze({...source}), deliveries: []});
        this.requests.set(requestId, messageId); return messageId;
    }
    capture(origin: QueuedPublicationOrigin, messageId: string, input: QueuedPublicationData, redelivered: boolean): void {
        validateQueuedPublicationData(input);
        const publication = this.publications.get(messageId);
        if (!publication || !origin.isCurrent() || origin.descriptor.kind !== 'ds-delivery'
            || this.options.consumerQueue(origin.worker) !== publication.data.queue || !same(input, publication.data)
            || origin.descriptor.queue !== publication.data.queue
            || origin.descriptor.payloadSha256 !== publication.data.payloadSha256 || !currentSource(publication.source))
            throw new Error('Queued delivery does not match original parent lineage');
        const existing = publication.deliveries.find(d => d.origin.worker === origin.worker && d.origin.attemptId === origin.attemptId);
        if (existing) return;
        if (publication.deliveries.length && (!redelivered || publication.deliveries.some(d => d.origin.isCurrent())))
            throw new Error('Duplicate or overlapping unfenced queued delivery');
        if (this.deliveryCount >= this.options.maximumDeliveries) throw new Error('Queued delivery lineage window exhausted');
        publication.deliveries.push({origin, redelivered}); this.deliveryCount++;
    }
    ended(origin: QueuedPublicationOrigin, status: WorkerAttemptEndDescription['status']): void {
        for (const p of this.publications.values()) {
            if (p.origin.worker === origin.worker && p.origin.attemptId === origin.attemptId) p.producerEnd = status;
            for (const d of p.deliveries) if (d.origin.worker === origin.worker && d.origin.attemptId === origin.attemptId) d.end = status;
        }
    }
    snapshot() {
        return {observationOnly: true, capacityReleased: false, publications: [...this.publications.values()].map(p => ({
            messageId: p.messageId, ...p.data, source: {chainId: p.source.chainId, generation: p.source.generation, readerSessionId: p.source.readerSessionId},
            producer: {epoch: p.origin.epoch, incarnation: p.origin.incarnation, attemptId: p.origin.attemptId,
                consumerId: p.origin.descriptor.consumerId, publisherId: p.origin.descriptor.publisherId, binding: {...p.origin.binding}},
            producerEnd: p.producerEnd ?? null, sourceCurrent: currentSource(p.source), brokerSettlement: 'unknown',
            queuedOrUncertainEncodedBytes: p.data.payloadBytes + p.data.headersBytes,
            deliveries: p.deliveries.map(d => ({epoch: d.origin.epoch, incarnation: d.origin.incarnation, attemptId: d.origin.attemptId,
                consumerId: d.origin.descriptor.consumerId, queue: d.origin.descriptor.queue, redelivered: d.redelivered,
                end: d.end ?? null, originalEncodedBytes: p.data.payloadBytes + p.data.headersBytes}))}))};
    }
}
