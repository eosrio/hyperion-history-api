import type {FastifyRequest} from 'fastify';
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {ProtocolAbiProofUnavailableError, isUnsettledCertificate, type ProtocolAbiProofReadOptions} from '../../indexer/protocol/abi-proof.js';
import {withProofReadRecovery} from '../../indexer/protocol/proof-consumer-scope.js';
import {ProtocolNativeActionUnavailableError} from '../../indexer/protocol/native-authorization.js';

const cancelled = () => new ProtocolAbiProofUnavailableError('proof_cancelled', 'ABI proof request was cancelled');
const streamSignals = new WeakMap<object, AbortSignal>();
const cancellationReasons = new WeakMap<object, ProtocolAbiProofUnavailableError>();
interface ProofAttempt {scope: object; key: object; signal: AbortSignal; deadline(): number | undefined; startProof(): number; active: boolean}
const attempts = new AsyncLocalStorage<ProofAttempt>();
export interface ProtocolApiProofReadOptions extends ProtocolAbiProofReadOptions {readonly timeoutMs?: number}

function attemptFor(scope: object): ProofAttempt | undefined {
    const attempt = attempts.getStore();
    return attempt?.scope === scope ? attempt : undefined;
}

/** Failed HTTP attempts never share proof arrays or grants with their replacement. */
export function protocolProofScope(scope: object): object {
    assertProtocolProofRequestActive(scope);
    return attemptFor(scope)?.key ?? scope;
}

async function bounded<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let stop!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
        stop = () => reject(signal.reason);
        signal.addEventListener('abort', stop, {once: true});
    });
    try {return await Promise.race([Promise.resolve().then(() => {signal.throwIfAborted(); return operation();}), stopped]);}
    finally {signal.removeEventListener('abort', stop);}
}

/** HTTP route/query/shaping/final-output work shares one bound, never one timeout per action.
 * Stream batches and direct helper callers retain their independently managed lifetime.
 */
export async function withProtocolProofTransaction<T>(scope: object, operation: () => Promise<T>, timeoutMs = 5000): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid API proof transaction bound');
    if (attemptFor(scope)) throw new Error('Nested API proof transaction');
    assertProtocolProofRequestActive(scope);
    const raw = (scope as Partial<FastifyRequest>).raw, lifetime = new AbortController();
    const expired = () => new ProtocolAbiProofUnavailableError('proof_timeout', 'API proof transaction timed out');
    const cancel = () => lifetime.abort(reason(scope)), expire = () => lifetime.abort(expired());
    const socketTimeout = raw?.socket?.timeout;
    const bound = typeof socketTimeout === 'number' && socketTimeout > 0 ? Math.min(timeoutMs, socketTimeout) : timeoutMs;
    // Raw/unproved history keeps its existing ES/cache timeout. The one shared proof
    // clock starts only when a consumer actually demands authority, not on route entry.
    let deadline: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const startProof = () => {
        if (deadline === undefined) {deadline = performance.now() + bound; timer = setTimeout(expire, bound);}
        return deadline;
    };
    raw?.once('aborted', cancel); raw?.socket?.once('close', cancel); raw?.socket?.once('timeout', expire);
    try {
        while (true) {
            lifetime.signal.throwIfAborted(); assertProtocolProofRequestActive(scope);
            const controller = new AbortController(), attempt: ProofAttempt = {scope, key: {}, signal: controller.signal,
                deadline: () => deadline, startProof, active: true};
            const abort = () => controller.abort(lifetime.signal.reason);
            lifetime.signal.addEventListener('abort', abort, {once: true});
            try {
                const result = await bounded(lifetime.signal, () => attempts.run(attempt, operation));
                lifetime.signal.throwIfAborted();
                if (deadline !== undefined && performance.now() >= deadline) throw expired();
                return result;
            }
            catch (error) {
                lifetime.signal.throwIfAborted();
                if (deadline === undefined || !(error instanceof ProtocolAbiProofUnavailableError || error instanceof ProtocolNativeActionUnavailableError)
                    || (error.code !== 'authority_changed' && !isUnsettledCertificate(error))) throw error;
            } finally {
                attempt.active = false; controller.abort(cancelled());
                lifetime.signal.removeEventListener('abort', abort);
            }
            await bounded(lifetime.signal, () => delay(50, undefined, {signal: lifetime.signal}));
        }
    } finally {
        if (timer) clearTimeout(timer); raw?.removeListener('aborted', cancel);
        raw?.socket?.removeListener('close', cancel); raw?.socket?.removeListener('timeout', expire);
        lifetime.abort(cancelled());
    }
}
interface ProofSocket {
    readonly connected?: boolean;
    once?(event: 'disconnect', listener: () => void): unknown;
    removeListener?(event: 'disconnect', listener: () => void): unknown;
}

/** One stream batch owns one signal; losing one recipient never cancels remaining recipients. */
export function createProtocolStreamScope(sockets: readonly ProofSocket[]): {scope: object; dispose(): void} {
    const scope = {}, controller = new AbortController(), active = new Set(sockets.filter(socket => socket.connected !== false));
    const listeners: {socket: ProofSocket; listener: () => void}[] = [];
    streamSignals.set(scope, controller.signal);
    for (const socket of active) {
        const listener = () => {active.delete(socket); if (!active.size) controller.abort(cancelled());};
        socket.once?.('disconnect', listener); listeners.push({socket, listener});
    }
    if (!active.size) controller.abort(cancelled());
    return {scope, dispose() {
        for (const {socket, listener} of listeners) socket.removeListener?.('disconnect', listener);
        controller.abort(cancelled());
    }};
}

function reason(scope: object): ProtocolAbiProofUnavailableError {
    let value = cancellationReasons.get(scope);
    if (!value) {value = cancelled(); cancellationReasons.set(scope, value);}
    return value;
}

/** Plain objects are stream-batch scopes, whose lifetime is managed by the stream lane. */
export function assertProtocolProofRequestActive(scope: object): void {
    const attempt = attemptFor(scope);
    if (attempt) {
        attempt.signal.throwIfAborted();
        if (!attempt.active) throw cancelled();
        const deadline = attempt.deadline();
        if (deadline !== undefined && performance.now() >= deadline)
            throw new ProtocolAbiProofUnavailableError('proof_timeout', 'API proof transaction timed out');
    }
    streamSignals.get(scope)?.throwIfAborted();
    const raw = (scope as Partial<FastifyRequest>).raw;
    if (raw?.aborted || raw?.socket?.destroyed) throw reason(scope);
}

/** Stop HTTP proof continuations on disconnect without retaining per-request listeners. */
export async function withProtocolProofRequest<T>(scope: object,
    operation: (options: ProtocolApiProofReadOptions) => Promise<T>): Promise<T> {
    const attempt = attemptFor(scope);
    if (attempt) {
        assertProtocolProofRequestActive(scope);
        const deadline = attempt.startProof();
        const value = await bounded(attempt.signal, () => withProofReadRecovery({key:attempt.key,signal:attempt.signal,
            remainingMs:()=>deadline-performance.now()}, () => operation({signal: attempt.signal,
            timeoutMs: Math.max(1, Math.ceil(deadline - performance.now()))})));
        assertProtocolProofRequestActive(scope); return value;
    }
    const raw = (scope as Partial<FastifyRequest>).raw;
    const streamSignal = streamSignals.get(scope);
    if (!raw && !streamSignal) return operation({});
    assertProtocolProofRequestActive(scope);
    const controller = new AbortController(), signal = streamSignal ?? controller.signal;
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => {controller.abort(reason(scope)); reject(streamSignal?.aborted ? streamSignal.reason : controller.signal.reason);};
    });
    raw?.once('aborted', abort);
    raw?.socket?.once('close', abort);
    streamSignal?.addEventListener('abort', abort, {once: true});
    try {
        const value = await Promise.race([operation({signal}), stopped]);
        assertProtocolProofRequestActive(scope);
        return value;
    } finally {
        raw?.removeListener('aborted', abort);
        raw?.socket?.removeListener('close', abort);
        streamSignal?.removeEventListener('abort', abort);
        controller.abort();
    }
}
