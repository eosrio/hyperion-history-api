export interface PauseTarget {
    id: number;
    send(message: { event: string; mId: string }, callback: (error?: Error | null) => void): void;
    onFailure?(listener: () => void): () => void;
}

interface PauseRequest {
    type: string;
    targets: Set<number>;
    pending: Set<number>;
    respond: (message: object) => void;
    timeout: ReturnType<typeof setTimeout>;
    dispose: (() => void)[];
}

/** Converts worker IPC acknowledgments into one all-worker controller response. */
export class IndexerPauseCoordinator {
    private requests = new Map<string, PauseRequest>();

    constructor(private timeoutMs = 8000) {}

    pause(mId: string, type: string, workers: PauseTarget[], respond: (message: object) => void): void {
        if (this.requests.has(mId)) return;
        if (workers.length === 0 || [...this.requests.values()].some(request => request.type === type)) {
            respond({ event: 'indexer_pause_failed', mId, error: workers.length === 0
                ? `No ${type} workers are available to pause`
                : `A pause for ${type} is already pending` });
            return;
        }

        const targets = new Set(workers.map(worker => worker.id));
        const request: PauseRequest = {
            type, targets, pending: new Set(targets), respond, dispose: [],
            timeout: setTimeout(() => this.fail(mId, 'Timed out waiting for every worker to pause; some workers may remain paused'), this.timeoutMs)
        };
        this.requests.set(mId, request);
        for (const worker of workers) {
            if (!this.requests.has(mId)) break;
            try {
                if (worker.onFailure) {
                    const dispose = worker.onFailure(() => this.fail(mId, `Worker ${worker.id} disconnected while pausing`));
                    if (!this.requests.has(mId)) { dispose(); break; }
                    request.dispose.push(dispose);
                }
                worker.send({ event: 'pause_indexer', mId }, error => {
                    if (error) this.fail(mId, `Cannot pause worker ${worker.id}: ${error.message}`);
                });
            } catch (reason) {
                this.fail(mId, `Cannot pause worker ${worker.id}: ${String(reason)}`);
            }
        }
    }

    onWorkerResponse(workerId: number, message: { event: string; mId?: string; error?: string }): void {
        if (!message.mId) return;
        const request = this.requests.get(message.mId);
        if (!request || !request.targets.has(workerId)) return;
        if (message.event === 'indexer_pause_failed') {
            this.fail(message.mId, `Worker ${workerId} could not pause: ${message.error || 'unknown error'}`);
        } else if (message.event === 'indexer_paused') {
            request.pending.delete(workerId);
            if (request.pending.size === 0) {
                this.finish(message.mId, { event: 'indexer_paused', mId: message.mId,
                    complete: true, workerIds: [...request.targets] });
            }
        }
    }

    private fail(mId: string, error: string): void {
        this.finish(mId, { event: 'indexer_pause_failed', mId, error });
    }

    private finish(mId: string, response: object): void {
        const request = this.requests.get(mId);
        if (!request) return;
        this.requests.delete(mId);
        clearTimeout(request.timeout);
        for (const dispose of request.dispose) dispose();
        request.respond(response);
    }
}
