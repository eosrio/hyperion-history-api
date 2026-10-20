import type {FastifyRequest} from 'fastify';
import {ProtocolAbiProofUnavailableError, type ProtocolAbiProofReadOptions} from '../../indexer/protocol/abi-proof.js';

const cancelled = () => new ProtocolAbiProofUnavailableError('proof_cancelled', 'ABI proof request was cancelled');

/** Plain objects are stream-batch scopes, whose lifetime is managed by the stream lane. */
export function assertProtocolProofRequestActive(scope: object): void {
    const raw = (scope as Partial<FastifyRequest>).raw;
    if (raw?.aborted || raw?.socket?.destroyed) throw cancelled();
}

/** Stop HTTP proof continuations on disconnect without retaining per-request listeners. */
export async function withProtocolProofRequest<T>(scope: object,
    operation: (options: ProtocolAbiProofReadOptions) => Promise<T>): Promise<T> {
    const raw = (scope as Partial<FastifyRequest>).raw;
    if (!raw) return operation({});
    assertProtocolProofRequestActive(scope);
    const controller = new AbortController();
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => {controller.abort(); reject(cancelled());};
    });
    raw.once('aborted', abort);
    raw.socket?.once('close', abort);
    try {
        const value = await Promise.race([operation({signal: controller.signal}), stopped]);
        assertProtocolProofRequestActive(scope);
        return value;
    } finally {
        raw.removeListener('aborted', abort);
        raw.socket?.removeListener('close', abort);
        controller.abort();
    }
}
