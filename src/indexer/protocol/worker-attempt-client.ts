import {randomUUID} from 'node:crypto';
import {ProofConsumerScope, currentProofConsumerScope, assertProofConsumerEnd} from './proof-consumer-scope.js';
import {consumeFreshActionWrite, type FreshActionWrite} from '../history/action-fresh-write.js';
import {workerAttemptJson, workerAttemptDigest, validateWorkerAttemptDescriptor, validateWorkerAttemptBinding,
    validateFreshActionWrite,
    type WorkerAttemptDescriptor, type WorkerAttemptBinding, type WorkerAttemptRole, type WorkerAttemptTransport,
    type WorkerAttemptEndDescription} from './worker-attempt-supervisor.js';

declare const attemptBrand: unique symbol;
export interface WorkerAttempt {readonly [attemptBrand]: true}
interface Attempt {
    handle: WorkerAttempt; id: string; sequence: number; descriptor: WorkerAttemptDescriptor; scope: ProofConsumerScope;
    accepted: Promise<void>; challenge?: string; binding: WorkerAttemptBinding; bindingVersion: number;
    acknowledgementAttempted: boolean; ended?: WorkerAttemptEndDescription; running: boolean;
    freshWrites: FreshActionWrite[]; freshWriteOverflow: boolean;
    fenceTimer?: ReturnType<typeof setTimeout>;
}
type Managed = {mode: 'managed'; role: WorkerAttemptRole; transport: WorkerAttemptTransport};
type Controlled = {mode: 'controlled-local-only'; role: WorkerAttemptRole};
type Options = (Managed | Controlled) & {timeoutMs?: number; drainTimeoutMs?: number; retries?: number};
/** Existing worker IPC only. Controlled local scopes can never issue master-accepted end authority. */
export class WorkerAttemptClient {
    private readonly clientId = randomUUID();
    private readonly attempts = new WeakMap<WorkerAttempt, Attempt>();
    private readonly scopes = new Map<ProofConsumerScope, Attempt>();
    private readonly pending = new Map<string, {resolve: (value: any) => void; reject: (error: Error) => void}>();
    private sequence = 0;
    private authority?: {epoch: string; incarnation: string};
    private opening?: Promise<void>;
    private stopped = false;
    private pendingFence?: {epoch: string; incarnation: string; sequence: number; stop: boolean};
    private readonly timeout: number;
    private readonly drainTimeout: number;
    private readonly retries: number;
    private readonly onMessage = (message: any) => {
        if (message?.event === 'worker_attempt_reply' && typeof message.requestId === 'string') this.pending.get(message.requestId)?.resolve(message.result);
        else if (['worker_attempt_fence','worker_attempt_fence_active'].includes(message?.event)) {
            const stop = message.event === 'worker_attempt_fence';
            if (message.epoch === this.authority?.epoch && message.incarnation === this.authority?.incarnation) {
                if (stop) this.fenceAll(); else this.fenceActiveAttempts();
            } else if (!this.authority && typeof message.epoch === 'string' && typeof message.incarnation === 'string')
                this.pendingFence = {epoch: message.epoch, incarnation: message.incarnation, sequence: this.sequence, stop};
        }
    };
    private readonly onDisconnect = () => {this.fenceAll(); for (const request of this.pending.values()) request.reject(new Error('Worker lifecycle IPC disconnected'));};
    constructor(private readonly options: Options) {
        this.timeout = options.timeoutMs ?? 5000; this.drainTimeout = options.drainTimeoutMs ?? 5000; this.retries = options.retries ?? 2;
        if (![this.timeout,this.drainTimeout].every(value => Number.isSafeInteger(value) && value >= 10 && value <= 30000)
            || !Number.isSafeInteger(this.retries) || this.retries < 0 || this.retries > 3) throw new Error('Invalid worker lifecycle IPC bounds');
        if (options.mode === 'managed') {
            options.transport.on('message', this.onMessage); options.transport.on('disconnect', this.onDisconnect);
        }
    }
    get mode() {return this.options.mode;}
    get role() {return this.options.role;}
    private async request(payload: Record<string, unknown>): Promise<any> {
        if (this.options.mode !== 'managed') throw new Error('Local-only scope has no master IPC authority');
        if (this.pending.size >= 4096) throw new Error('Worker lifecycle request budget exhausted');
        const requestId = randomUUID(), message = JSON.parse(workerAttemptJson({event: 'worker_attempt_request', requestId,
            payload: {clientId: this.clientId, ...payload}}));
        let failure: unknown;
        for (let attempt = 0; attempt <= this.retries; attempt++) {
            try {
                const result = await new Promise<any>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Worker lifecycle IPC response is unknown')), this.timeout);
                    this.pending.set(requestId, {resolve: value => {clearTimeout(timer); resolve(value);},
                        reject: error => {clearTimeout(timer); reject(error);}});
                    try {this.options.mode === 'managed' && this.options.transport.send(message, error => {if (error) this.pending.get(requestId)?.reject(error);});}
                    catch (error) {this.pending.get(requestId)?.reject(error instanceof Error ? error : new Error('Worker lifecycle IPC send failed'));}
                });
                if (!result || result.ok !== true) throw new Error(typeof result?.error === 'string' ? result.error : 'Worker lifecycle authority unavailable');
                return result;
            } catch (error) {failure = error;}
            finally {this.pending.delete(requestId);}
        }
        throw failure;
    }
    private open(): Promise<void> {
        if (this.opening) return this.opening;
        this.opening = (async () => {
            if (this.options.mode === 'controlled-local-only') return;
            const result = await this.request({operation: 'hello'});
            if (this.stopped || result.role !== this.options.role || typeof result.epoch !== 'string' || typeof result.incarnation !== 'string')
                throw new Error('Worker lifecycle parent/role changed');
            this.authority = {epoch: result.epoch, incarnation: result.incarnation};
            const fence = this.pendingFence; this.pendingFence = undefined;
            if (fence && fence.epoch === result.epoch && fence.incarnation === result.incarnation) {
                if (fence.stop) this.stopped = true;
                for (const record of this.scopes.values()) if (record.sequence <= fence.sequence) record.scope.fence();
            }
        })();
        void this.opening.catch(() => {}); return this.opening;
    }
    /** Capture at physical receipt before cargo can wait. Semantic membership is deliberately optional. */
    capture(descriptor: WorkerAttemptDescriptor): WorkerAttempt {
        if (this.stopped || this.scopes.size >= 4096 || this.sequence === Number.MAX_SAFE_INTEGER) throw new Error('Worker lifecycle custody is unavailable');
        validateWorkerAttemptDescriptor(descriptor, this.options.role);
        const handle = Object.freeze({}) as WorkerAttempt, id = randomUUID(), sequence = ++this.sequence;
        const record: Attempt = {handle, id, sequence, descriptor: JSON.parse(workerAttemptJson(descriptor)), scope: new ProofConsumerScope(id),
            accepted: Promise.resolve(), binding: {}, bindingVersion: 0, acknowledgementAttempted: false, running: false,
            freshWrites: [], freshWriteOverflow: false};
        this.attempts.set(handle, record); this.scopes.set(record.scope, record);
        record.scope.signal.addEventListener('abort', () => {
            record.fenceTimer = setTimeout(() => {
                if (this.scopes.has(record.scope)) this.requestSupervisedRetirement();
            }, this.drainTimeout).unref();
        }, {once: true});
        record.accepted = (async () => {
            await this.open();
            if (this.stopped) throw new Error('Worker lifecycle stopped before registration');
            if (this.options.mode === 'controlled-local-only') return;
            const result = await this.request({operation: 'register', ...this.authority, attemptId: id, sequence, descriptor: record.descriptor});
            if (result.epoch !== this.authority?.epoch || result.incarnation !== this.authority?.incarnation || result.attemptId !== id
                || typeof result.challenge !== 'string' || result.descriptorSha256 !== workerAttemptDigest(record.descriptor))
                throw new Error('Worker lifecycle registration response mismatch');
            record.challenge = result.challenge;
        })();
        void record.accepted.catch(() => {}); return handle;
    }
    private record(handle: WorkerAttempt): Attempt {
        const record = this.attempts.get(handle); if (!record) throw new Error('Unissued or foreign worker attempt handle'); return record;
    }
    async bind(handle: WorkerAttempt, fields: WorkerAttemptBinding): Promise<void> {
        const record = this.record(handle); record.scope.assertActive(); validateWorkerAttemptBinding(fields);
        for (const [key, value] of Object.entries(fields)) if (Object.hasOwn(record.binding, key) && (record.binding as any)[key] !== value)
            throw new Error('Original worker attempt binding changed');
        const binding = JSON.parse(workerAttemptJson({...record.binding, ...fields}));
        await record.accepted; record.scope.assertActive();
        await record.scope.operation(async () => {
            if (this.options.mode === 'managed') {
                const result = await this.request({operation: 'bind', ...this.authority, attemptId: record.id, sequence: record.sequence,
                    challenge: record.challenge, version: record.bindingVersion + 1, binding});
                if (result.bindingSha256 !== workerAttemptDigest(binding)) throw new Error('Worker binding response mismatch');
            }
            record.scope.assertActive(); record.binding = binding; record.bindingVersion++;
        });
    }
    async bindCurrent(fields: WorkerAttemptBinding): Promise<void> {
        const scope = currentProofConsumerScope(true)!, record = this.scopes.get(scope);
        if (!record) throw new Error('Proof context is not owned by this worker lifecycle');
        await this.bind(record.handle, fields);
    }
    markAcknowledgementAttempt(): void {
        const scope = currentProofConsumerScope(true)!, record = this.scopes.get(scope);
        if (!record) throw new Error('Worker ACK lacks its original attempt');
        scope.assertActive(); record.acknowledgementAttempted = true;
    }
    /** A fresh store return is associated with this physical receipt, never inferred from record JSON. */
    async observeFreshActionWrite(result: object): Promise<boolean> {
        const scope = currentProofConsumerScope(true)!, record = this.scopes.get(scope);
        if (!record) throw new Error('Fresh action write lacks its original worker attempt');
        scope.assertActive();
        const write = consumeFreshActionWrite(result);
        validateFreshActionWrite(write);
        if (this.options.mode === 'controlled-local-only' || record.freshWriteOverflow) return false;
        await record.accepted; scope.assertActive();
        return scope.operation(async () => {
            const response = await this.request({operation: 'observe', ...this.authority, attemptId: record.id,
                sequence: record.sequence, challenge: record.challenge, write});
            scope.assertActive();
            if (response.epoch !== this.authority?.epoch || response.incarnation !== this.authority?.incarnation
                || response.attemptId !== record.id || response.writeSha256 !== workerAttemptDigest(write)
                || typeof response.accepted !== 'boolean' || typeof response.freshWriteOverflow !== 'boolean'
                || (!response.accepted && !response.freshWriteOverflow))
                throw new Error('Worker fresh-write observation response mismatch');
            if (response.accepted) {
                const existing = record.freshWrites.find(value => value.kind === write.kind && value.id === write.id);
                if (existing && workerAttemptJson(existing) !== workerAttemptJson(write))
                    throw new Error('Conflicting local fresh action write');
                if (!existing) record.freshWrites.push(write);
                record.freshWrites.sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
            }
            record.freshWriteOverflow ||= response.freshWriteOverflow;
            return response.accepted;
        });
    }
    assertCurrent(handle: WorkerAttempt): void {
        const record = this.record(handle), scope = currentProofConsumerScope(true);
        if (scope !== record.scope) throw new Error('Worker receipt belongs to another attempt');
        scope.assertActive();
    }
    private async boundedDrain(scope: ProofConsumerScope): Promise<void> {
        let timer!: ReturnType<typeof setTimeout>;
        try {
            const end = await Promise.race([scope.closeAndDrain(), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Worker attempt remains physically undrained; supervised exit required')), this.drainTimeout);
            })]);
            assertProofConsumerEnd(scope, end);
        } finally {clearTimeout(timer);}
    }
    private requestSupervisedRetirement(): void {
        this.fenceAll();
        if (this.options.mode === 'managed') void this.request({operation: 'retire-owner', ...this.authority}).catch(() => {});
    }
    async run<T>(handle: WorkerAttempt, operation: () => T | Promise<T>): Promise<T> {
        const record = this.record(handle);
        if (record.running || record.ended) throw new Error('Worker attempt root cannot be repeated');
        record.running = true;
        let rootResult: 'returned' | 'threw' = 'threw';
        try {
            try {await record.accepted;} catch (error) {this.requestSupervisedRetirement(); throw error;}
            record.scope.assertActive();
            const result = await record.scope.run(operation); rootResult = 'returned'; return result;
        } finally {
            try {await this.boundedDrain(record.scope);}
            catch (error) {
                // A deadline proves no drainage. Ask the parent to supervise the exact physical owner;
                // keep this unresolved local scope until actual process exit, without an end request.
                this.requestSupervisedRetirement();
                throw error;
            }
            if (this.options.mode === 'managed' && record.challenge) {
                // No successful receipt can originate from caller JSON or an un-drained local scope.
                const result = await this.request({operation: 'end', ...this.authority, attemptId: record.id, sequence: record.sequence,
                    challenge: record.challenge, descriptorSha256: workerAttemptDigest(record.descriptor), bindingSha256: workerAttemptDigest(record.binding),
                    summary: {acknowledgementAttempted: record.acknowledgementAttempted, rootResult}});
                const expected = {epoch: this.authority?.epoch, incarnation: this.authority?.incarnation, attemptId: record.id,
                    role: this.options.role, status: 'quiescent', descriptor: record.descriptor, binding: record.binding,
                    acknowledgementAttempted: record.acknowledgementAttempted, rootResult,
                    freshWrites: record.freshWrites, freshWriteOverflow: record.freshWriteOverflow};
                if (workerAttemptJson(result.end) !== workerAttemptJson(expected)) throw new Error('Worker end response mismatch');
                record.ended = result.end;
            }
            if (record.fenceTimer) clearTimeout(record.fenceTimer);
            this.scopes.delete(record.scope);
        }
    }
    fenceAll(): void {this.stopped = true; for (const record of this.scopes.values()) record.scope.fence();}
    fenceActiveAttempts(): void {for (const record of this.scopes.values()) record.scope.fence();}
    /** Original physical channel retirement affects queued roots too, before their processing starts. */
    fenceChannel(channelId: string): void {
        for (const record of this.scopes.values()) if (record.descriptor.consumerId === channelId || record.descriptor.publisherId === channelId) record.scope.fence();
    }
    describe(handle: WorkerAttempt) {const record = this.record(handle); return Object.freeze({attemptId: record.id, mode: this.options.mode,
        descriptor: {...record.descriptor}, binding: {...record.binding}, scope: record.scope.snapshot(), masterEnd: record.ended ? {...record.ended} : null});}
    dispose(): void {
        this.onDisconnect();
        if (this.options.mode === 'managed') {
            this.options.transport.removeListener('message', this.onMessage); this.options.transport.removeListener('disconnect', this.onDisconnect);
        }
    }
}
export function createControlledLocalAttemptClient(role: WorkerAttemptRole): WorkerAttemptClient {
    return new WorkerAttemptClient({mode: 'controlled-local-only', role});
}
