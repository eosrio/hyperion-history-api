/** Connection lifetime used by canonical proof work, independently of public framing. */
export interface StreamConnection {
    readonly id: string;
    readonly connected: boolean;
    once(event: 'disconnect', listener: () => void): unknown;
    removeListener(event: 'disconnect', listener: () => void): unknown;
}

export interface HistoryStart {
    readonly requestId: string;
    /** First matching hit, not the request's resolved inclusive replay anchor. */
    readonly firstBlock: number;
    readonly totalResults: number;
}

export interface HistoryBatch {
    readonly requestId: string;
    readonly kind: 'action' | 'delta';
    readonly messages: readonly unknown[];
    readonly filtered: number;
}

/**
 * Admission is transport flow control, never an application durability receipt.
 * An adapter must bound its queued/in-flight work and stop waits on connection loss.
 */
export interface HistoryAcceptance {
    readonly status: boolean;
    readonly error?: unknown;
}

/** Shared history queries, filters and proofs use this seam for both transports. */
export interface StreamHistoryDelivery {
    readonly connection: StreamConnection;
    begin(start: HistoryStart): void;
    deliver(batch: HistoryBatch, timeoutMs: number): Promise<HistoryAcceptance>;
}
