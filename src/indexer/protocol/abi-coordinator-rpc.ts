import {randomUUID} from 'node:crypto';

export interface ProtocolAbiOpenResult {generation: string; resumeFromBlock: number | null}
export interface ProtocolAbiAdmitResult {status: 'accepted' | 'backpressure' | 'stale'; generation: string}
export type ProtocolAbiCoordinatorRequest = {
    event: 'protocol_abi_coordinator_request'; mId: string;
    data: {operation: 'open'; contextId: string; readerSessionId: string}
        | {operation: 'admit'; selectionId: string; readerSessionId: string; generation: string};
};
export interface ProtocolAbiCoordinatorReply {
    event: 'protocol_abi_coordinator_reply'; mId: string;
    data: {ok: true; result: ProtocolAbiOpenResult | ProtocolAbiAdmitResult}
        | {ok: false; error: {code: string; message: string}};
}
export class ProtocolAbiCoordinatorRpcError extends Error {
    constructor(readonly code: string, message: string) {super(message); this.name = 'ProtocolAbiCoordinatorRpcError';}
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const keys = (value: any, names: string[]) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
export function isProtocolAbiCoordinatorRequest(message: any): message is ProtocolAbiCoordinatorRequest {
    if (message?.event !== 'protocol_abi_coordinator_request' || typeof message.mId !== 'string'
        || !/^[0-9a-f-]{36}$/.test(message.mId) || !text(message.data?.readerSessionId)) return false;
    const input = message.data;
    return (input.operation === 'open' && keys(input, ['operation', 'contextId', 'readerSessionId'])
        && /^h45srcctx1:[0-9a-f]{64}$/.test(input.contextId))
        || (input.operation === 'admit' && keys(input, ['operation', 'selectionId', 'readerSessionId', 'generation'])
        && /^h45srcsel1:[0-9a-f]{64}$/.test(input.selectionId) && text(input.generation));
}

/** A reader holds at most one request; waiting for capacity never occupies the master mutation queue. */
export class ProtocolAbiCoordinatorRpc {
    private pending?: {id: string; operation: 'open' | 'admit'; timer: NodeJS.Timeout;
        resolve: (result: ProtocolAbiOpenResult | ProtocolAbiAdmitResult) => void; reject: (error: Error) => void};
    constructor(private readonly send: (message: ProtocolAbiCoordinatorRequest, callback: (error: Error | null) => void) => unknown = (message, callback) => {
        if (!process.send) throw new ProtocolAbiCoordinatorRpcError('ipc_unavailable', 'Canonical coordinator requires master IPC');
        return process.send(message, callback);
    }, private readonly timeoutMs = 30000) {}

    open(contextId: string, readerSessionId: string): Promise<ProtocolAbiOpenResult> {
        return this.request({operation: 'open', contextId, readerSessionId}) as Promise<ProtocolAbiOpenResult>;
    }
    admit(selectionId: string, readerSessionId: string, generation: string): Promise<ProtocolAbiAdmitResult> {
        return this.request({operation: 'admit', selectionId, readerSessionId, generation}) as Promise<ProtocolAbiAdmitResult>;
    }
    private request(data: ProtocolAbiCoordinatorRequest['data']): Promise<ProtocolAbiOpenResult | ProtocolAbiAdmitResult> {
        if (this.pending) return Promise.reject(new ProtocolAbiCoordinatorRpcError('request_pending', 'Reader already has a pending coordinator request'));
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            const timer = setTimeout(() => this.fail(id, new ProtocolAbiCoordinatorRpcError('timeout', 'Canonical coordinator request timed out')), this.timeoutMs);
            this.pending = {id, operation: data.operation, timer, resolve, reject};
            try { this.send({event: 'protocol_abi_coordinator_request', mId: id, data}, error => {if (error) this.fail(id, error);}); }
            catch (error) {this.fail(id, error instanceof Error ? error : new Error(String(error)));}
        });
    }
    onMessage(message: any): boolean {
        if (message?.event !== 'protocol_abi_coordinator_reply') return false;
        const pending = this.pending;
        if (!pending || message.mId !== pending.id) return true;
        const reply = message.data;
        if (reply?.ok === false && text(reply.error?.code) && typeof reply.error?.message === 'string') {
            this.fail(pending.id, new ProtocolAbiCoordinatorRpcError(reply.error.code, reply.error.message.slice(0, 4096).toWellFormed()));
            return true;
        }
        const result = reply?.result;
        const valid = reply?.ok === true && text(result?.generation) && (pending.operation === 'open'
            ? keys(result, ['generation', 'resumeFromBlock']) && (result.resumeFromBlock === null
                || (Number.isSafeInteger(result.resumeFromBlock) && result.resumeFromBlock >= 1 && result.resumeFromBlock <= 0xffffffff))
            : keys(result, ['status', 'generation']) && ['accepted', 'backpressure', 'stale'].includes(result.status));
        if (!valid) {this.fail(pending.id, new ProtocolAbiCoordinatorRpcError('invalid_reply', 'Malformed coordinator response')); return true;}
        clearTimeout(pending.timer); this.pending = undefined; pending.resolve(result);
        return true;
    }
    cancel(): void {
        if (this.pending) this.fail(this.pending.id, new ProtocolAbiCoordinatorRpcError('cancelled', 'Reader socket changed during coordinator request'));
    }
    private fail(id: string, error: Error): void {
        const pending = this.pending;
        if (!pending || pending.id !== id) return;
        clearTimeout(pending.timer); this.pending = undefined; pending.reject(error);
    }
}
