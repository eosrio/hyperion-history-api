import {setTimeout as delay} from 'node:timers/promises';

/** Default bound for one trace: long enough for the historical walk to activate the next root, short
 * enough that a root which never covers the block still ends in the existing incomplete record. */
export const historicalSourceWaitMs = 10 * 60 * 1000;

export interface HistoricalSourceWaitOptions {
    maxWaitMs?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Ends the wait at once with the signal's reason, e.g. when the owning worker attempt is fenced. */
    signal?: AbortSignal;
    /** Called once, before the first retry, so callers can log or profile the wait. */
    onWait?: (error: Error & {code: string}) => void;
}

function historicalSourcePending(error: unknown): error is Error & {code: string} {
    return error instanceof Error && (error as {code?: unknown}).code === 'historical_source_unavailable';
}

/**
 * Retries one source opening while the coordinator's activated historical root does not yet cover it.
 * Only `historical_source_unavailable` is retried; every other result, including success, returns or
 * throws exactly as the first call would. When the bound is spent, the last such error is thrown.
 * An aborted signal stops the wait before the next attempt and during a backoff, throwing its reason,
 * so a fenced worker attempt can drain without waiting out the bound.
 */
export async function waitForHistoricalSource<T>(open: () => Promise<T>, options: HistoricalSourceWaitOptions = {}): Promise<T> {
    const maxWaitMs = options.maxWaitMs ?? historicalSourceWaitMs, maxDelayMs = options.maxDelayMs ?? 5000;
    const now = options.now ?? Date.now, signal = options.signal;
    const sleep = options.sleep ?? ((ms, abort) => delay(ms, undefined, {signal: abort}));
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) throw new Error('Invalid historical source wait bound');
    const deadline = now() + maxWaitMs;
    let wait = options.initialDelayMs ?? 250, notified = false;
    while (true) {
        try {
            return await open();
        } catch (error) {
            if (!historicalSourcePending(error)) throw error;
            const remaining = deadline - now();
            if (remaining <= 0) throw error;
            signal?.throwIfAborted();
            if (!notified) {notified = true; options.onWait?.(error);}
            try {await sleep(Math.min(wait, remaining), signal);}
            catch (failure) {signal?.throwIfAborted(); throw failure;}
            signal?.throwIfAborted();
            wait = Math.min(wait * 2, maxDelayMs);
        }
    }
}
