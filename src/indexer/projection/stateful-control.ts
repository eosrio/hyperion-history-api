import {randomUUID} from 'node:crypto';

export const validStatefulProbeId = (value: unknown): value is string => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const validStatefulProbeTarget = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
interface WorkerPort {send(message: unknown, callback: (error: Error | null) => void): unknown}
interface SocketPort {readonly readyState: number; send(message: string, callback: (error?: Error) => void): unknown}
interface Pending<Owner> {owner: Owner; target: string; finish(current: boolean): void}
function bounds(maximum: number, timeoutMs: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
        throw new Error('Invalid stateful request probe budget');
}

/** Master-owned nonce map binds replies to one actual current physical Worker object. */
export class StatefulWorkerProbeBroker<Worker extends WorkerPort> {
    private readonly pending = new Map<string, Pending<Worker>>();
    constructor(private readonly maximum: number, private readonly timeoutMs: number, private readonly isCurrent: (worker: Worker) => boolean) {bounds(maximum, timeoutMs);}
    probe(worker: Worker, target: string, signal?: AbortSignal): Promise<boolean> {
        if (!validStatefulProbeTarget(target) || signal?.aborted || !this.isCurrent(worker) || this.pending.size >= this.maximum) return Promise.resolve(false);
        return new Promise(resolve => {
            const requestId = randomUUID(), abort = () => finish(false);
            const finish = (current: boolean) => {
                if (!this.pending.delete(requestId)) return;
                clearTimeout(timer); signal?.removeEventListener('abort', abort);
                resolve(current && !signal?.aborted && this.isCurrent(worker));
            };
            const timer = setTimeout(() => finish(false), this.timeoutMs);
            this.pending.set(requestId, {owner: worker, target, finish}); signal?.addEventListener('abort', abort, {once: true});
            if (signal?.aborted) {finish(false); return;}
            try {worker.send({event: 'stateful_owner_probe_request', data: {requestId, target}}, error => {if (error) finish(false);});}
            catch {finish(false);}
        });
    }
    accept(worker: Worker, reply: any): void {
        const held = this.pending.get(reply?.requestId);
        if (!held || held.owner !== worker || held.target !== reply.target || typeof reply.current !== 'boolean') return;
        held.finish(reply.current);
    }
    retired(worker: Worker): void {for (const held of [...this.pending.values()]) if (held.owner === worker) held.finish(false);}
}

/** API-owned request map uses the existing controller socket; no new listener or time-based grant. */
export class StatefulApiProbeClient<Socket extends SocketPort> {
    private readonly pending = new Map<string, Pending<Socket>>();
    constructor(private readonly maximum: number, private readonly timeoutMs: number, private readonly socket: () => Socket | undefined) {bounds(maximum, timeoutMs);}
    currentSocket(): Socket | undefined {const socket = this.socket(); return socket?.readyState === 1 ? socket : undefined;}
    probe(target: string, signal: AbortSignal): Promise<boolean> {
        const socket = this.currentSocket();
        if (!socket || signal.aborted || !validStatefulProbeTarget(target) || this.pending.size >= this.maximum) return Promise.resolve(false);
        return new Promise(resolve => {
            const requestId = randomUUID(), abort = () => finish(false);
            const finish = (current: boolean) => {
                if (!this.pending.delete(requestId)) return;
                clearTimeout(timer); signal.removeEventListener('abort', abort);
                resolve(current && !signal.aborted && this.currentSocket() === socket);
            };
            const timer = setTimeout(() => finish(false), this.timeoutMs);
            this.pending.set(requestId, {owner: socket, target, finish}); signal.addEventListener('abort', abort, {once: true});
            if (signal.aborted) {finish(false); return;}
            try {socket.send(JSON.stringify({event: 'stateful_owner_probe', requestId, target}), error => {if (error) finish(false);});}
            catch {finish(false);}
        });
    }
    accept(socket: Socket, bytes: string): void {
        if (bytes.length > 512) return;
        let reply: any; try {reply = JSON.parse(bytes);} catch {return;}
        if (reply?.event !== 'stateful_owner_probe_reply') return;
        const held = this.pending.get(reply.requestId);
        if (!held || held.owner !== socket || held.target !== reply.target || typeof reply.current !== 'boolean') return;
        held.finish(reply.current);
    }
    disconnected(socket: Socket): void {for (const held of [...this.pending.values()]) if (held.owner === socket) held.finish(false);}
}
