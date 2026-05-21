export class WorkerProfiler {
    private metrics: Record<string, { totalTimeMs: number; count: number }> = {};
    private interval: NodeJS.Timeout | null = null;

    constructor(
        private workerRole: string,
        private workerId: string | number,
        private enabled: boolean
    ) {}

    startReporting() {
        if (!this.enabled) return;
        this.interval = setInterval(() => {
            this.report();
        }, 1000);
    }

    stopReporting() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.report(); // Send final report
    }

    private report() {
        if (!this.enabled) return;
        if (Object.keys(this.metrics).length > 0) {
            try {
                process.send?.({
                    event: 'profiling_report',
                    worker_role: this.workerRole,
                    worker_id: this.workerId,
                    metrics: this.metrics
                });
                this.metrics = {};
            } catch (err) {
                // Ignore IPC errors on shutdown
            }
        }
    }

    record(name: string, durationMs: number) {
        if (!this.enabled) return;
        if (!this.metrics[name]) {
            this.metrics[name] = { totalTimeMs: 0, count: 0 };
        }
        this.metrics[name].totalTimeMs += durationMs;
        this.metrics[name].count += 1;
    }

    start(name: string): () => void {
        if (!this.enabled) {
            return () => {};
        }
        const startHrTime = process.hrtime.bigint();
        return () => {
            const endHrTime = process.hrtime.bigint();
            const durationMs = Number(endHrTime - startHrTime) / 1000000;
            this.record(name, durationMs);
        };
    }

    async profile<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
        if (!this.enabled) {
            return await fn();
        }
        const stop = this.start(name);
        try {
            return await fn();
        } finally {
            stop();
        }
    }
}
