import { HyperionConfig } from "../../interfaces/hyperionConfig.js";
import { HyperionMaster } from "./master.js";
import Timeout = NodeJS.Timeout;
import { ConnectionManager } from "../connections/manager.class.js";
import { hLog } from "../helpers/common_functions.js";

type QueueScope = 'bulk' | 'live' | 'shared';
type QueueObservation = {queue: string; scope: QueueScope; size: number; limit: number; resume_trigger: number};
type PressureSample = {status: 'missing' | 'current' | 'failed'; sampled_at: string | null;
    reason: 'not_sampled' | 'missing_input' | 'invalid_metric' | 'check_failed' | null;
    queues: QueueObservation[]; scopes: {bulk: boolean; live: boolean; shared: boolean} | null};

export class HyperionQueueMonitor {

    master: HyperionMaster;
    conf: HyperionConfig;
    manager: ConnectionManager;


    private queueMonitoringInterval?: Timeout;
    private readonly readingPaused = {reader: true, continuous_reader: true};
    private checking = false;
    private sample: PressureSample = {status: 'missing', sampled_at: null, reason: 'not_sampled', queues: [], scopes: null};

    // The sample is the last completed check, not a liveness guarantee. Role flags
    // describe this monitor's decisions, not manual or other reader pause sources.
    getPressureSnapshot() {
        const sampledAt = this.sample.sampled_at === null ? NaN : Date.parse(this.sample.sampled_at);
        const age = Date.now() - sampledAt;
        const sample_age_ms = Number.isFinite(age) && age >= 0 ? age : null;
        return { ...this.sample, sample_age_ms, status: this.checking && this.sample.status === 'current' ? 'stale' as const : this.sample.status, checking: this.checking, queue_monitor_paused_roles: {...this.readingPaused},
            queues: this.sample.queues.map(queue => ({...queue})),
            scopes: this.sample.scopes ? {...this.sample.scopes} : null };
    }
    chain: string;

    constructor(master: HyperionMaster) {
        this.master = master;
        this.conf = this.master.conf;
        this.chain = this.master.chain;
        this.manager = this.master.manager;
    }

    isReaderPaused(role: 'reader' | 'continuous_reader'): boolean {
        return this.readingPaused[role];
    }

    private updateReader(role: 'reader' | 'continuous_reader', aboveLimit: boolean, canResume: boolean) {
        if (aboveLimit && !this.readingPaused[role]) {
            this.readingPaused[role] = true;
            try { this.master.sendToRole(role, {event: 'pause', source: 'queue-pressure'}); }
            catch (error) { hLog(`Reader pressure delivery request failed for ${role}:`, error); }
        } else if (!aboveLimit && canResume && this.readingPaused[role]) {
            this.readingPaused[role] = false;
            try { this.master.sendToRole(role, {event: 'resume', source: 'queue-pressure'}); }
            catch (error) { hLog(`Reader pressure delivery request failed for ${role}:`, error); }
        }
    }

    private async checkQueues(autoscaleConsumers: Record<string, number>, limit: number) {
        if (this.checking) return;
        this.checking = true;
        let reason: PressureSample['reason'] = 'check_failed';
        try {
            type Scope = 'bulk' | 'live' | 'shared';
            const queues = new Map<string, {scope: Scope; limit: number; ingestor?: HyperionMaster['workerMap'][number]}>();
            for (const worker of this.master.workerMap) {
                let queue = worker.queue || worker.worker_queue;
                if (worker.worker_role === 'ds_pool_worker') queue = `${this.chain}:ds_pool:${worker.local_id}`;
                if (!queue) continue;
                const input = worker.worker_role === 'deserializer';
                const bulkPrefix = `${this.chain}:blocks:`;
                const scope: Scope = input && queue === `${this.chain}:live_blocks` && (worker.live_mode === undefined || worker.live_mode === 'true') ? 'live'
                    : input && queue.startsWith(bulkPrefix) && /^[1-9][0-9]*$/.test(queue.slice(bulkPrefix.length)) && (worker.live_mode === undefined || worker.live_mode === 'false') ? 'bulk' : 'shared';
                const qlimit = input ? this.conf.scaling.block_queue_limit : this.conf.scaling.max_queue_limit;
                const previous = queues.get(queue);
                queues.set(queue, {scope: previous && previous.scope !== scope ? 'shared' : scope,
                    limit: previous ? Math.min(previous.limit, qlimit) : qlimit,
                    ingestor: previous?.ingestor ?? (worker.worker_role === 'ingestor' ? worker : undefined)});
            }
            const hasBulk = [...queues.values()].some(item => item.scope === 'bulk');
            const hasLive = [...queues.values()].some(item => item.scope === 'live');
            if ((!hasBulk && this.master.workerMap.some(worker => worker.worker_role === 'reader'))
                || (!hasLive && this.master.workerMap.some(worker => worker.worker_role === 'continuous_reader'))) {
                reason = 'missing_input';
                throw new Error('Active reader input queue is not observed');
            }
            const pressure = {bulk: {above: !hasBulk, resume: hasBulk}, live: {above: !hasLive, resume: hasLive}, shared: {above: false, resume: true}};
            const observations: QueueObservation[] = [];
            for (const [queue, item] of queues) {
                const size = await this.manager.checkQueueSize(queue);
                if (!Number.isSafeInteger(size) || size < 0) { reason = 'invalid_metric'; throw new Error(`Invalid queue size for ${queue}`); }
                observations.push({queue, scope: item.scope, size, limit: item.limit, resume_trigger: this.conf.scaling.resume_trigger});
                const state = pressure[item.scope];
                if (size >= item.limit) state.above = true;
                if (size >= this.conf.scaling.resume_trigger) state.resume = false;
                if (item.ingestor && size > limit) {
                    if (!autoscaleConsumers[queue]) autoscaleConsumers[queue] = 0;
                    if (autoscaleConsumers[queue] < this.conf.scaling.max_autoscale) {
                        hLog(`${queue} is above the limit (${size}/${limit}). Launching consumer...`);
                        this.master.addWorker({queue, type: item.ingestor.type, worker_role: 'ingestor'});
                        this.master.launchWorkers();
                        autoscaleConsumers[queue]++;
                    }
                }
            }
            this.updateReader('reader', pressure.shared.above || pressure.bulk.above, pressure.shared.resume && pressure.bulk.resume);
            this.updateReader('continuous_reader', pressure.shared.above || pressure.live.above, pressure.shared.resume && pressure.live.resume);
            this.sample = {status: 'current', sampled_at: new Date().toISOString(), reason: null, queues: observations,
                scopes: {bulk: hasBulk, live: hasLive, shared: [...queues.values()].some(item => item.scope === 'shared')}};
        } catch (error) {
            this.sample = {status: 'failed', sampled_at: new Date().toISOString(), reason, queues: [], scopes: null};
            // Unknown queue pressure must not release either reader.
            this.updateReader('reader', true, false);
            this.updateReader('continuous_reader', true, false);
            hLog('Queue monitoring failed; reader pause requested:', error);
        } finally {
            this.checking = false;
            // Reconcile the current physical readers on the existing bounded
            // poll cadence, including when startup synchronization was lost.
            this.master.reconcileReaderPressure?.();
        }
    }

    monitorIndexingQueues() {
        if (!this.queueMonitoringInterval) {
            hLog('Starting index queue monitoring, autoscaling enabled (trigger: ' + this.conf.scaling.auto_scale_trigger + ' messages)');
            const limit = this.conf.scaling.auto_scale_trigger;
            const autoscaleConsumers: Record<string, number> = {};
            setTimeout(() => {
                this.checkQueues(autoscaleConsumers, limit).catch(console.log);
            }, 3000);
            if (!this.conf.scaling.polling_interval) {
                this.conf.scaling.polling_interval = 20000;
            }
            this.queueMonitoringInterval = setInterval(async () => {
                await this.checkQueues(autoscaleConsumers, limit);
            }, this.conf.scaling.polling_interval);
        }
    }

}
