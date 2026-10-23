import type {Channel, ConfirmChannel, Options} from 'amqplib';
import {randomUUID} from 'node:crypto';
import {actionHistoryImmutableJson} from './action-history-manifest.js';
import {currentProofConsumerScope, assertProofConsumerCapability, trackProofConsumerOperation, proofConsumerSignal, type ProofConsumerScope} from '../protocol/proof-consumer-scope.js';

export interface ActionPublicationOwner {consumer: Channel; publisher: ConfirmChannel; current: () => boolean}
const ownerScopes = new WeakMap<ActionPublicationOwner, ProofConsumerScope>();
function publicationScope(owner: ActionPublicationOwner): ProofConsumerScope | undefined {
    const current = currentProofConsumerScope(), prior = ownerScopes.get(owner);
    if (prior) {assertProofConsumerCapability(prior); return prior;}
    if (current) ownerScopes.set(owner, current);
    return current;
}
/** Bind the original host owner when it is issued, including later use outside its async context. */
export function bindActionPublicationOwnerToScope(owner: ActionPublicationOwner): ActionPublicationOwner {
    publicationScope(owner); return owner;
}
/** One in-flight publication per caller. False is accepted buffering; wait for drain and confirm, never resend it. */
async function confirmAdmittedAction(owner: ActionPublicationOwner, queue: string, payload: Buffer,
                                     options: Options.Publish, signal?: AbortSignal): Promise<string> {
    const scope = publicationScope(owner);
    return trackProofConsumerOperation(async () => {
    signal = proofConsumerSignal(signal);
    signal?.throwIfAborted();
    if (!owner.current()) throw new Error('Action publication lost its original channels');
    const publisher = owner.publisher, messageId = randomUUID();
    await new Promise<void>((resolve, reject) => {
        let confirmed = false, drained = false, sent = false, settled = false;
        let invocationEnded = false, channelClosed = false, physicalStarted = false, physicalEnded = false;
        let resolvePhysical: (() => void) | undefined;
        const cleanChannelListeners = () => {
            publisher.off('drain', onDrain); publisher.off('close', onClose); publisher.off('error', onError);
        };
        const finishPhysical = () => {
            if (!physicalStarted || physicalEnded || !invocationEnded || !channelClosed && !(confirmed && drained)) return;
            physicalEnded = true; cleanChannelListeners(); resolvePhysical!();
        };
        const finish = (error?: unknown) => {
            if (settled) return;
            if (!error && (!sent || !confirmed || !drained)) return;
            settled = true; clearTimeout(timer);
            if (!physicalStarted || physicalEnded) cleanChannelListeners();
            publisher.off('return', onReturn); signal?.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else {
                try {
                    assertProofConsumerCapability(scope);
                    if (!owner.current()) throw new Error('Action publication channels changed before confirmation');
                    resolve();
                } catch (stale) {reject(stale);}
            }
        };
        const onDrain = () => {drained = true; finishPhysical(); finish();};
        const onClose = () => {channelClosed = true; finishPhysical(); finish(new Error('Action publisher closed before confirmation'));};
        const onError = (error: unknown) => finish(error);
        const onReturn = (message: any) => {if (message.properties?.messageId === messageId) finish(new Error('Admitted action was unroutable'));};
        const onAbort = () => finish(signal?.reason ?? new Error('Action publication cancelled'));
        const timer = setTimeout(() => finish(new Error('Action publication confirmation/drain timed out')), 30_000);
        publisher.on('drain', onDrain); publisher.on('close', onClose); publisher.on('error', onError); publisher.on('return', onReturn);
        signal?.addEventListener('abort', onAbort, {once: true});
        try {
            // Cancellation during listener setup must not authorize a new send.
            signal?.throwIfAborted(); assertProofConsumerCapability(scope);
            if (settled) return;
            if (scope) {
                // Keep the actual callback/buffer lifecycle separate from the abortable caller wait.
                // A thrown/unknown send remains pending until confirm+drain or observed channel close.
                void scope.operation(() => new Promise<void>(yes => {resolvePhysical = yes;}));
                physicalStarted = true;
            }
            // Register ownership before send: a controlled or failed channel can settle synchronously.
            const writable = publisher.sendToQueue(queue, payload, {...options, persistent: true, mandatory: true, messageId}, error => {
                confirmed = true; finishPhysical(); finish(error ?? undefined);
            });
            drained ||= writable; sent = true; finish();
        } catch (error) {finish(error);}
        finally {invocationEnded = true; finishPhysical();}
    });
    signal?.throwIfAborted();
    assertProofConsumerCapability(scope);
    if (!owner.current()) throw new Error('Action publication lost its original channels after confirmation');
    return messageId;
    }, scope);
}

/** Ordinary callers retain their void contract; a confirm alone issues no source-work authority. */
export async function publishAdmittedAction(owner: ActionPublicationOwner, queue: string, payload: Buffer,
                                            options: Options.Publish, signal?: AbortSignal): Promise<void> {
    await confirmAdmittedAction(owner, queue, payload, options, signal);
}

export const actionPublicationEvidenceBounds = Object.freeze({maximumPublications: 100_000,
    maximumBytes: 128 * 1024 * 1024, maximumHeaderBytes: 64 * 1024});
declare const confirmedPublicationBrand: unique symbol;
export interface ConfirmedActionPublication {readonly [confirmedPublicationBrand]: true}
interface PublicationEvidence {
    owner: ActionPublicationOwner; current: () => boolean; queue: string; payload: Buffer; headersJson: string; messageId: string;
    scope?: ProofConsumerScope;
}
const confirmed = new WeakMap<object, PublicationEvidence>();

/** Validate aggregate bytes before ticket snapshots or any output is sent. No memory-budget qualification. */
export function assertActionPublicationBatchBudget(publications: readonly {payload: Uint8Array; headers: unknown}[]): void {
    if (!Array.isArray(publications) || publications.length < 1 || publications.length > actionPublicationEvidenceBounds.maximumPublications)
        throw new Error('Action handoff publication vector exceeds its bounds');
    let bytes = 0;
    for (const entry of publications) {
        if (!(entry.payload instanceof Uint8Array)) throw new Error('Action handoff payload is not bytes');
        const headers = actionHistoryImmutableJson(entry.headers, actionPublicationEvidenceBounds.maximumHeaderBytes);
        bytes += entry.payload.byteLength + Buffer.byteLength(headers);
        if (bytes > actionPublicationEvidenceBounds.maximumBytes) throw new Error('Action handoff aggregate publication bytes exceed their bounds');
    }
}

/** Opaque same-process evidence is issued only after the owned mandatory/persistent confirm AND drain. */
export async function publishAdmittedActionWithEvidence(owner: ActionPublicationOwner, queue: string, payload: Buffer,
                                                       options: Options.Publish, signal?: AbortSignal): Promise<ConfirmedActionPublication> {
    const scope = publicationScope(owner);
    signal?.throwIfAborted();
    const consumer = owner.consumer, publisher = owner.publisher, predicate = owner.current;
    const current = () => owner.consumer === consumer && owner.publisher === publisher && owner.current === predicate && predicate();
    if (!current()) throw new Error('Action evidence lost its original publication owner');
    if (typeof queue !== 'string' || queue.length < 1 || queue.length > 255) throw new Error('Invalid action evidence route');
    assertActionPublicationBatchBudget([{payload, headers: options.headers ?? {}}]);
    // Both sent data and retained evidence detach before the first await. Caller hooks cannot rewrite them later.
    const headersJson = actionHistoryImmutableJson(options.headers ?? {}, actionPublicationEvidenceBounds.maximumHeaderBytes);
    const sent = Buffer.from(payload), retained = Buffer.from(sent);
    const messageId = await confirmAdmittedAction(owner, queue, sent, {...options, headers: JSON.parse(headersJson)}, signal);
    signal?.throwIfAborted();
    assertProofConsumerCapability(scope);
    if (!current()) throw new Error('Action evidence publication owner changed before issuance');
    const ticket = Object.freeze({}) as ConfirmedActionPublication;
    confirmed.set(ticket, {owner, current, queue, payload: retained, headersJson, messageId, scope});
    return ticket;
}

/** Private admission consumer: validate the entire issued vector before copying/parsing any retained bytes. */
function retainedPublicationRecords(owner: ActionPublicationOwner, tickets: readonly ConfirmedActionPublication[], reservedBytes = 0) {
    if (!Array.isArray(tickets) || tickets.length < 1 || tickets.length > actionPublicationEvidenceBounds.maximumPublications)
        throw new Error('Action handoff confirmation vector exceeds its bounds');
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > actionPublicationEvidenceBounds.maximumBytes)
        throw new Error('Action handoff aggregate reserved bytes exceed their bounds');
    let bytes = reservedBytes;
    const records: PublicationEvidence[] = [];
    for (let index = 0; index < tickets.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(tickets, String(index));
        const record = descriptor && 'value' in descriptor ? confirmed.get(descriptor.value) : undefined;
        if (!record || record.owner !== owner || !record.current()) throw new Error('Unissued, wrong-owner or stale action confirmation evidence');
        assertProofConsumerCapability(record.scope);
        bytes += record.payload.length + Buffer.byteLength(record.headersJson);
        if (bytes > actionPublicationEvidenceBounds.maximumBytes) throw new Error('Action handoff aggregate confirmation bytes exceed their bounds');
        records.push(record);
    }
    return {records, bytes};
}

/** Private budget admission only: no byte copies/parsing and no publication/source capability is returned. */
export function confirmedActionPublicationBytes(owner: ActionPublicationOwner, tickets: readonly ConfirmedActionPublication[]): number {
    return retainedPublicationRecords(owner, tickets).bytes;
}
export function readConfirmedActionPublications(owner: ActionPublicationOwner, tickets: readonly ConfirmedActionPublication[], reservedBytes = 0) {
    return retainedPublicationRecords(owner, tickets, reservedBytes).records.map(record => ({queue: record.queue,
        payload: Buffer.from(record.payload), headers: JSON.parse(record.headersJson), headersJson: record.headersJson}));
}
