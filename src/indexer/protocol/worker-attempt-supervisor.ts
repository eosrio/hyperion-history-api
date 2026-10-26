import {createHash, randomUUID} from 'node:crypto';
import {isPromise} from 'node:util/types';
import {actionHistoryImmutableJson} from '../history/action-history-manifest.js';
import type {FreshActionWrite} from '../history/action-fresh-write.js';

export type WorkerAttemptRole = 'deserializer' | 'ds_pool_worker' | 'projection';
export type WorkerAttemptKind = 'source-delivery' | 'ds-delivery' | 'projection-initialization' | 'projection-frame';
export interface WorkerAttemptDescriptor {
    kind: WorkerAttemptKind; receiptId: string; payloadSha256: string; headersSha256: string | null;
    consumerId: string | null; publisherId: string | null; queue: string | null; deliveryTag: number | null;
}
export interface WorkerAttemptBinding {
    selectionId?: string; ingressId?: string; admissionId?: string; planId?: string | null;
    blockNum?: number; blockId?: string; traceOrdinal?: number; configurationSha256?: string;
    targetName?: string; targetUuid?: string; readerSessionId?: string; sourceGeneration?: string;
    projectionId?: string; bindingSha256?: string; checkpointBlockNum?: number; checkpointBlockId?: string;
}
export interface WorkerAttemptTransport {
    on(event: string, listener: (...args: any[]) => void): unknown;
    removeListener(event: string, listener: (...args: any[]) => void): unknown;
    send(message: any, callback?: (error: Error | null) => void): unknown;
}
export interface PhysicalAttemptWorker extends WorkerAttemptTransport {isConnected(): boolean; kill?(signal?: NodeJS.Signals): unknown}
interface Owner {
    worker: PhysicalAttemptWorker; role: WorkerAttemptRole; incarnation: string; clientId?: string;
    state: 'active' | 'retired'; sequence: number; entries: Map<string, Entry>; completed: string[];
    terminationTimer?: ReturnType<typeof setTimeout>;
    activeFenceTimer?: ReturnType<typeof setTimeout>; fencedAttempts: Set<string>;
    listeners: {message: (message: any) => void; disconnect: () => void; exit: () => void};
}
interface Entry {
    size: number;
    id: string; sequence: number; descriptor: WorkerAttemptDescriptor; descriptorJson: string; challenge: string;
    registrationRequest: string; binding: WorkerAttemptBinding; bindingVersion: number; bindingRequest?: string;
    freshWrites: FreshActionWrite[]; freshWriteBytes: number; freshWriteOverflow: boolean;
    endRequest?: string; endJson?: string; end?: WorkerAttemptEndDescription;
}
export interface WorkerAttemptEndDescription {
    epoch: string; incarnation: string; attemptId: string; role: WorkerAttemptRole;
    status: 'quiescent' | 'process-exited-unresolved';
    descriptor: WorkerAttemptDescriptor; binding: WorkerAttemptBinding;
    acknowledgementAttempted: boolean | null; rootResult: 'returned' | 'threw' | 'unknown';
    freshWrites: readonly FreshActionWrite[]; freshWriteOverflow: boolean;
}
declare const acceptedEndBrand: unique symbol;
export interface AcceptedWorkerAttemptEnd {readonly [acceptedEndBrand]: true}
declare const observationBrand: unique symbol;
export interface WorkerAttemptObservation {readonly [observationBrand]: true}
export interface WorkerAttemptObservationDescription {
    readonly phase: 'registered' | 'bound' | 'ended';
    readonly worker: PhysicalAttemptWorker;
    readonly owner: {readonly epoch: string; readonly incarnation: string; readonly attemptId: string};
    readonly role: WorkerAttemptRole;
    readonly descriptor: WorkerAttemptDescriptor;
    readonly binding: WorkerAttemptBinding;
    /** Lifecycle observation only; does not establish canonical source membership or permission. */
    readonly isActive: () => boolean;
}
const observations = new WeakMap<WorkerAttemptObservation, {issuer: WorkerAttemptSupervisor;
    description: WorkerAttemptObservationDescription; active: boolean; consumed: boolean}>();
const accepted = new WeakMap<object, {supervisor: WorkerAttemptSupervisor; value: WorkerAttemptEndDescription}>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const roles = new Set(['deserializer', 'ds_pool_worker', 'projection']);
export const workerAttemptBounds = Object.freeze({maximumOwners: 256, maximumActive: 4096,
    maximumRetainedEndsPerOwner: 256, maximumMetadataBytes: 64 * 1024 * 1024, maximumMessageBytes: 16 * 1024,
    maximumFreshWritesPerAttempt: 32, maximumFreshWriteBytesPerAttempt: 8 * 1024});
export const workerAttemptJson = (value: unknown) => actionHistoryImmutableJson(value, workerAttemptBounds.maximumMessageBytes);
export const workerAttemptDigest = (value: unknown) => createHash('sha256').update(workerAttemptJson(value)).digest('hex');
function keys(value: any, expected: string[]) {return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === expected.sort().join('|');}
export function validateWorkerAttemptDescriptor(value: WorkerAttemptDescriptor, role: WorkerAttemptRole): void {
    if (!keys(value, ['kind','receiptId','payloadSha256','headersSha256','consumerId','publisherId','queue','deliveryTag'])
        || !uuid.test(value.receiptId) || !hash.test(value.payloadSha256) || !(value.headersSha256 === null || hash.test(value.headersSha256))
        || ![value.consumerId, value.publisherId].every(id => id === null || typeof id === 'string' && uuid.test(id))
        || !(value.queue === null || typeof value.queue === 'string' && value.queue.length > 0 && value.queue.length <= 255 && value.queue.isWellFormed())
        || !(value.deliveryTag === null || Number.isSafeInteger(value.deliveryTag) && value.deliveryTag >= 0)
        || !(role === 'deserializer' ? value.kind === 'source-delivery' : role === 'ds_pool_worker' ? value.kind === 'ds-delivery'
            : ['projection-initialization','projection-frame'].includes(value.kind))) throw new Error('Invalid worker attempt custody');
    workerAttemptJson(value);
}
export function validateWorkerAttemptBinding(value: WorkerAttemptBinding): void {
    const numeric = new Set(['blockNum','traceOrdinal','checkpointBlockNum']);
    const allowed = new Set(['selectionId','ingressId','admissionId','planId','blockNum','blockId','traceOrdinal','configurationSha256',
        'targetName','targetUuid','readerSessionId','sourceGeneration','projectionId','bindingSha256','checkpointBlockNum','checkpointBlockId']);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid worker attempt verified binding');
    for (const [key, field] of Object.entries(value)) {
        if (!allowed.has(key) || !(field === null && key === 'planId' || numeric.has(key)
            ? field === null && key === 'planId' || Number.isSafeInteger(field) && Number(field) >= (key === 'blockNum' ? 1 : 0)
            : typeof field === 'string' && field.length > 0 && field.length <= 256 && field.isWellFormed()))
            throw new Error('Invalid worker attempt binding field');
    }
    workerAttemptJson(value);
}
export function validateFreshActionWrite(value: FreshActionWrite): void {
    if (!keys(value, ['kind','id','recordSha256','workSha256','classification'])
        || !(value.kind === 'confirmed-handoff' && typeof value.id === 'string' && /^h45actionhandoff1:[0-9a-f]{64}$/.test(value.id)
            || value.kind === 'attempt-disposition' && typeof value.id === 'string' && /^h45actionattempt1:[0-9a-f]{64}$/.test(value.id))
        || !hash.test(value.recordSha256) || !hash.test(value.workSha256)
        || !(value.kind === 'confirmed-handoff' ? value.classification === 'confirmed-handoff'
            : ['intentional-no-effect','intentional-suppression','source-incomplete','contract-incomplete',
                'raw-incomplete'].includes(value.classification))) throw new Error('Invalid fresh action write');
    workerAttemptJson(value);
}
/** Private parent-side census. It never grants source progress, reader credit or recovered authority. */
export class WorkerAttemptSupervisor {
    readonly epoch = randomUUID();
    private readonly owners = new Map<PhysicalAttemptWorker, Owner>();
    private active = 0;
    private metadataBytes = 0;
    private stopped = false;
    private overflow = false;
    private observationFailures = 0;
    private observationEmitted = 0;
    constructor(private readonly options: {onEnd?: (end: AcceptedWorkerAttemptEnd) => void;
        /** Internal synchronous observation only; never grants processing, source or capacity authority. */
        onObservation?: (value: WorkerAttemptObservation) => void;
        maximumOwners?: number; maximumActive?: number; maximumRetainedEndsPerOwner?: number; maximumMetadataBytes?: number; fenceTimeoutMs?: number} = {}) {
        for (const [key, maximum] of Object.entries(workerAttemptBounds)) {
            const value = (options as any)[key];
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) throw new Error('Invalid worker supervisor bound');
        }
        if (options.fenceTimeoutMs !== undefined && (!Number.isSafeInteger(options.fenceTimeoutMs) || options.fenceTimeoutMs < 10 || options.fenceTimeoutMs > 30000))
            throw new Error('Invalid worker fence deadline');
    }
    attach(worker: PhysicalAttemptWorker, role: WorkerAttemptRole): void {
        if (!roles.has(role) || this.stopped) throw new Error('Worker attempt supervisor is unavailable');
        const prior = this.owners.get(worker);
        if (prior) {if (prior.role !== role) throw new Error('Cannot replace physical attempt role'); return;}
        if (this.owners.size >= (this.options.maximumOwners ?? workerAttemptBounds.maximumOwners)) {
            this.overflow = true; throw new Error('Physical attempt owner budget exhausted');
        }
        const listeners = {message: (message: any) => {this.handle(worker, message);},
            disconnect: () => this.retire(worker), exit: () => this.observeExit(worker)};
        this.owners.set(worker, {worker, role, incarnation: randomUUID(), state: 'active', sequence: 0, entries: new Map(), completed: [], fencedAttempts: new Set(), listeners});
        worker.on('message', listeners.message); worker.on('disconnect', listeners.disconnect); worker.on('exit', listeners.exit);
    }
    private reply(worker: PhysicalAttemptWorker, requestId: string, result: any): void {
        try {if (worker.isConnected()) worker.send({event: 'worker_attempt_reply', requestId, result}, () => {});} catch {}
    }
    private account(entry: Entry): Entry {
        const {size: previous, ...value} = entry;
        const size = Buffer.byteLength(actionHistoryImmutableJson(value, 64 * 1024));
        if (this.metadataBytes + size - previous > (this.options.maximumMetadataBytes ?? workerAttemptBounds.maximumMetadataBytes)) {
            this.overflow = true; throw new Error('Worker retained metadata budget exhausted');
        }
        this.metadataBytes += size - previous; return {...entry, size};
    }
    /** The caller is the captured physical Worker object, never a message-supplied ID/PID. */
    handle(worker: PhysicalAttemptWorker, message: any): boolean {
        if (message?.event !== 'worker_attempt_request') return false;
        const requestId = message.requestId, owner = this.owners.get(worker);
        if (typeof requestId !== 'string' || !uuid.test(requestId)) return true;
        try {
            workerAttemptJson(message);
            if (!owner) throw new Error('Unknown physical attempt owner');
            const input = message.payload;
            if (!input || !uuid.test(input.clientId)) throw new Error('Invalid worker lifecycle session');
            // A physical worker may always ask to retire itself, including after an unknown hello/register reply.
            // Retirement issues no end; only the exact captured process's observed exit can settle unresolved work.
            if (input.operation === 'retire-owner') {
                if (owner.clientId && owner.clientId !== input.clientId) throw new Error('Foreign retirement session');
                this.retire(worker); this.reply(worker, requestId, {ok: true, retired: true}); return true;
            }
            if (input.operation === 'hello') {
                if (this.stopped || owner.state !== 'active' || owner.clientId && owner.clientId !== input.clientId)
                    throw new Error('Worker attempt owner was retired or replaced');
                owner.clientId = input.clientId;
                this.reply(worker, requestId, {ok: true, epoch: this.epoch, incarnation: owner.incarnation, role: owner.role}); return true;
            }
            if (input.epoch !== this.epoch || input.incarnation !== owner.incarnation || input.clientId !== owner.clientId)
                throw new Error('Stale or foreign physical attempt authority');
            if (!uuid.test(input.attemptId) || !Number.isSafeInteger(input.sequence) || input.sequence < 1)
                throw new Error('Invalid physical attempt identity');
            let entry = owner.entries.get(input.attemptId);
            if (input.operation === 'register') {
                validateWorkerAttemptDescriptor(input.descriptor, owner.role);
                const descriptorJson = workerAttemptJson(input.descriptor);
                if (entry) {
                    if (entry.registrationRequest !== requestId || entry.sequence !== input.sequence || entry.descriptorJson !== descriptorJson)
                        throw new Error('Mismatched attempt registration retry');
                } else {
                    if (this.stopped || owner.state !== 'active' || input.sequence !== owner.sequence + 1)
                        throw new Error('Worker attempt registration is retired, expired or out of order');
                    if (this.active >= (this.options.maximumActive ?? workerAttemptBounds.maximumActive)
                        || this.metadataBytes + Buffer.byteLength(descriptorJson) > (this.options.maximumMetadataBytes ?? workerAttemptBounds.maximumMetadataBytes)) {
                        this.overflow = true; throw new Error('Worker attempt census budget exhausted');
                    }
                    entry = this.account({size: 0, id: input.attemptId, sequence: input.sequence, descriptor: JSON.parse(descriptorJson), descriptorJson,
                        challenge: randomUUID(), registrationRequest: requestId, binding: {}, bindingVersion: 0,
                        freshWrites: [], freshWriteBytes: 0, freshWriteOverflow: false});
                    owner.entries.set(entry.id, entry); owner.sequence = entry.sequence; this.active++;
                    this.observe(owner, entry, 'registered');
                }
                this.reply(worker, requestId, {ok: true, epoch: this.epoch, incarnation: owner.incarnation,
                    attemptId: entry.id, challenge: entry.challenge, descriptorSha256: workerAttemptDigest(entry.descriptor)}); return true;
            }
            if (!entry || entry.sequence !== input.sequence || entry.challenge !== input.challenge) throw new Error('Unknown or mismatched worker attempt');
            if (input.operation === 'retire') {
                this.retire(worker); this.reply(worker, requestId, {ok: true, retired: true}); return true;
            }
            if (input.operation === 'bind') {
                validateWorkerAttemptBinding(input.binding);
                if (entry.end) throw new Error('Worker attempt already ended');
                const bindingJson = workerAttemptJson(input.binding), currentJson = workerAttemptJson(entry.binding);
                if (input.version === entry.bindingVersion) {
                    if (entry.bindingRequest !== requestId || bindingJson !== currentJson) throw new Error('Mismatched binding retry');
                } else {
                    if (owner.state !== 'active' || input.version !== entry.bindingVersion + 1) throw new Error('Stale worker attempt binding');
                    for (const [key, value] of Object.entries(entry.binding)) if ((input.binding as any)[key] !== value)
                        throw new Error('Original attempt binding cannot be replaced');
                    entry = this.account({...entry, binding: JSON.parse(bindingJson), bindingVersion: input.version, bindingRequest: requestId});
                    owner.entries.set(entry.id, entry);
                    this.observe(owner, entry, 'bound');
                }
                this.reply(worker, requestId, {ok: true, bindingSha256: workerAttemptDigest(entry.binding)}); return true;
            }
            if (input.operation === 'observe') {
                if (entry.end || owner.state !== 'active') throw new Error('Worker attempt observation is retired');
                validateFreshActionWrite(input.write);
                const write: FreshActionWrite = JSON.parse(workerAttemptJson(input.write));
                const existing = entry.freshWrites.find(item => item.kind === write.kind && item.id === write.id);
                if (existing && workerAttemptJson(existing) !== workerAttemptJson(write))
                    throw new Error('Conflicting fresh action write for original attempt');
                if (!existing && entry.freshWrites.some(item => item.workSha256 === write.workSha256))
                    throw new Error('Conflicting fresh action work for original attempt');
                let acceptedWrite = !!existing;
                if (!existing && !entry.freshWriteOverflow) {
                    const bytes = Buffer.byteLength(workerAttemptJson(write));
                    if (entry.freshWrites.length >= workerAttemptBounds.maximumFreshWritesPerAttempt
                        || entry.freshWriteBytes + bytes > workerAttemptBounds.maximumFreshWriteBytesPerAttempt) {
                        entry = this.account({...entry, freshWriteOverflow: true});
                    } else {
                        const freshWrites = [...entry.freshWrites, write].sort((a, b) =>
                            (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
                        entry = this.account({...entry, freshWrites, freshWriteBytes: entry.freshWriteBytes + bytes});
                        acceptedWrite = true;
                    }
                    owner.entries.set(entry.id, entry);
                }
                this.reply(worker, requestId, {ok: true, epoch: this.epoch, incarnation: owner.incarnation,
                    attemptId: entry.id, accepted: acceptedWrite, freshWriteOverflow: entry.freshWriteOverflow,
                    writeSha256: workerAttemptDigest(write)}); return true;
            }
            if (input.operation !== 'end' || input.descriptorSha256 !== workerAttemptDigest(entry.descriptor)
                || input.bindingSha256 !== workerAttemptDigest(entry.binding)
                || !keys(input.summary, ['acknowledgementAttempted','rootResult'])
                || typeof input.summary.acknowledgementAttempted !== 'boolean' || !['returned','threw'].includes(input.summary.rootResult))
                throw new Error('Invalid worker attempt end association');
            const endJson = workerAttemptJson(input);
            if (entry.end) {
                if (entry.endRequest !== requestId || entry.endJson !== endJson) throw new Error('Mismatched or replayed worker end');
            } else {
                entry = this.end(owner, entry, 'quiescent', input.summary, {endRequest: requestId, endJson}); this.trim(owner);
            }
            this.reply(worker, requestId, {ok: true, end: entry.end});
        } catch (error) {this.reply(worker, requestId, {ok: false, error: error instanceof Error ? error.message : 'Worker attempt authority unavailable'});}
        return true;
    }
    private end(owner: Owner, entry: Entry, status: WorkerAttemptEndDescription['status'], summary?: {acknowledgementAttempted: boolean; rootResult: 'returned' | 'threw'},
                request?: {endRequest: string; endJson: string}): Entry {
        if (entry.end) return entry;
        const end: WorkerAttemptEndDescription = JSON.parse(workerAttemptJson({epoch: this.epoch, incarnation: owner.incarnation, attemptId: entry.id, role: owner.role,
            status, descriptor: entry.descriptor, binding: entry.binding, acknowledgementAttempted: summary?.acknowledgementAttempted ?? null,
            rootResult: summary?.rootResult ?? 'unknown', freshWrites: entry.freshWrites, freshWriteOverflow: entry.freshWriteOverflow}));
        const next = {...entry, ...request, end};
        if (status === 'quiescent') {entry = this.account(next); owner.entries.set(entry.id, entry);}
        this.active--; owner.completed.push(entry.id);
        owner.fencedAttempts.delete(entry.id);
        if (!owner.fencedAttempts.size && owner.activeFenceTimer) {clearTimeout(owner.activeFenceTimer); owner.activeFenceTimer = undefined;}
        const evidence = Object.freeze({}) as AcceptedWorkerAttemptEnd;
        accepted.set(evidence, {supervisor: this, value: end});
        this.observe(owner, entry, 'ended');
        try {this.options.onEnd?.(evidence);} catch {this.overflow = true;}
        return status === 'quiescent' ? entry : next;
    }
    private observe(owner: Owner, entry: Entry, phase: WorkerAttemptObservationDescription['phase']): void {
        try {
            const callback = this.options.onObservation;
            if (callback === undefined || owner.role !== 'ds_pool_worker') return;
            if (typeof callback !== 'function') throw new Error('Attempt observer unavailable');
            const metadata = JSON.parse(workerAttemptJson({owner: {epoch: this.epoch, incarnation: owner.incarnation, attemptId: entry.id},
                role: owner.role, descriptor: entry.descriptor, binding: entry.binding}));
            Object.freeze(metadata.owner); Object.freeze(metadata.descriptor); Object.freeze(metadata.binding);
            const token = Object.freeze({}) as WorkerAttemptObservation;
            const issued = {issuer: this, description: Object.freeze({...metadata, worker: owner.worker, phase, isActive: () => {
                const current = owner.entries.get(entry.id);
                return !this.stopped && this.owners.get(owner.worker) === owner && owner.state === 'active'
                    && !!current && !current.end && !owner.fencedAttempts.has(entry.id);
            }}), active: true, consumed: false};
            observations.set(token, issued); this.observationEmitted = Math.min(Number.MAX_SAFE_INTEGER, this.observationEmitted + 1);
            try {
                const result: unknown = callback(token);
                if (result !== undefined) {
                    if (isPromise(result)) Promise.prototype.then.call(result, () => {}, () => {});
                    throw new Error('Attempt observer must return synchronously without a value');
                }
            } finally {issued.active = false; observations.delete(token);}
        } catch {this.observationFailures = Math.min(Number.MAX_SAFE_INTEGER, this.observationFailures + 1);}
    }
    observationSnapshot() {return Object.freeze({observationOnly: true, emitted: this.observationEmitted, failures: this.observationFailures});}
    private trim(owner: Owner): void {
        const maximum = this.options.maximumRetainedEndsPerOwner ?? workerAttemptBounds.maximumRetainedEndsPerOwner;
        while (owner.completed.length > maximum) {
            const id = owner.completed.shift()!, entry = owner.entries.get(id)!;
            this.metadataBytes -= entry.size;
            owner.entries.delete(id); // The sequence watermark prevents old registration from becoming new authority.
        }
    }
    retire(worker: PhysicalAttemptWorker): void {
        const owner = this.owners.get(worker); if (!owner || owner.state === 'retired') return;
        owner.state = 'retired';
        if (owner.activeFenceTimer) {clearTimeout(owner.activeFenceTimer); owner.activeFenceTimer = undefined;}
        try {if (worker.isConnected()) worker.send({event: 'worker_attempt_fence', epoch: this.epoch, incarnation: owner.incarnation}, () => {});} catch {}
        // A fence request or kill call never proves exit. Keep the exact owner until its actual exit event.
        owner.terminationTimer = setTimeout(() => {
            try {worker.kill?.('SIGTERM');} catch {}
            owner.terminationTimer = setTimeout(() => {try {worker.kill?.('SIGKILL');} catch {}}, this.options.fenceTimeoutMs ?? 5000).unref();
        }, this.options.fenceTimeoutMs ?? 5000).unref();
    }
    observeExit(worker: PhysicalAttemptWorker): void {
        const owner = this.owners.get(worker); if (!owner) return;
        if (owner.terminationTimer) clearTimeout(owner.terminationTimer);
        if (owner.activeFenceTimer) clearTimeout(owner.activeFenceTimer);
        owner.state = 'retired';
        for (const entry of owner.entries.values()) {
            this.end(owner, entry, 'process-exited-unresolved');
            this.metadataBytes -= entry.size;
        }
        worker.removeListener('message', owner.listeners.message); worker.removeListener('disconnect', owner.listeners.disconnect); worker.removeListener('exit', owner.listeners.exit);
        this.owners.delete(worker);
    }
    stop(): void {this.stopped = true; for (const owner of this.owners.values()) this.retire(owner.worker);}
    fenceActive(): void {
        for (const owner of this.owners.values()) {
            for (const entry of owner.entries.values()) if (!entry.end) owner.fencedAttempts.add(entry.id);
            if (owner.fencedAttempts.size && !owner.activeFenceTimer) owner.activeFenceTimer = setTimeout(() => {
                owner.activeFenceTimer = undefined;
                if (owner.fencedAttempts.size) this.retire(owner.worker);
            }, this.options.fenceTimeoutMs ?? 5000).unref();
            try {if (owner.worker.isConnected()) owner.worker.send({event: 'worker_attempt_fence_active',
                epoch: this.epoch, incarnation: owner.incarnation}, () => {});} catch {}
        }
    }
    snapshot() {return Object.freeze({epoch: this.epoch, active: this.active, metadataBytes: this.metadataBytes, overflow: this.overflow,
        owners: [...this.owners.values()].map(owner => ({incarnation: owner.incarnation, role: owner.role, state: owner.state,
            attempts: [...owner.entries.values()].map(entry => ({attemptId: entry.id, descriptor: {...entry.descriptor}, binding: {...entry.binding},
                status: entry.end?.status ?? 'registered'}))}))});}
}
/** Original callback scope only. JSON, retained tokens and another supervisor cannot issue an owner. */
export function consumeWorkerAttemptObservation(supervisor: WorkerAttemptSupervisor, token: WorkerAttemptObservation): WorkerAttemptObservationDescription {
    const value = observations.get(token);
    if (!value || value.issuer !== supervisor || !value.active || value.consumed) throw new Error('Unissued or expired attempt observation');
    value.consumed = true; return value.description;
}
/** Read-only description of an actually issued same-supervisor end. JSON copies cannot reissue it. */
export function describeWorkerAttemptEnd(supervisor: WorkerAttemptSupervisor, evidence: AcceptedWorkerAttemptEnd): WorkerAttemptEndDescription {
    const issued = accepted.get(evidence); if (issued?.supervisor !== supervisor) throw new Error('Unissued or foreign worker end evidence');
    return JSON.parse(workerAttemptJson(issued.value));
}
