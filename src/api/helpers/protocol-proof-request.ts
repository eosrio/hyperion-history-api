import type {FastifyRequest} from 'fastify';
import {ProtocolAbiProofUnavailableError, type ProtocolAbiProofReadOptions} from '../../indexer/protocol/abi-proof.js';

const cancelled = () => new ProtocolAbiProofUnavailableError('proof_cancelled', 'ABI proof request was cancelled');
const streamSignals = new WeakMap<object, AbortSignal>();
const cancellationReasons = new WeakMap<object, ProtocolAbiProofUnavailableError>();
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
    streamSignals.get(scope)?.throwIfAborted();
    const raw = (scope as Partial<FastifyRequest>).raw;
    if (raw?.aborted || raw?.socket?.destroyed) throw reason(scope);
}

/** Stop HTTP proof continuations on disconnect without retaining per-request listeners. */
export async function withProtocolProofRequest<T>(scope: object,
    operation: (options: ProtocolAbiProofReadOptions) => Promise<T>): Promise<T> {
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
