import { HyperionConfig } from "../../interfaces/hyperionConfig.js";
import { HyperionMaster } from "./master.js";
import Timeout = NodeJS.Timeout;
import { ConnectionManager } from "../connections/manager.class.js";
import { hLog } from "../helpers/common_functions.js";

export class HyperionQueueMonitor {

    master: HyperionMaster;
    conf: HyperionConfig;
    manager: ConnectionManager;


    private queueMonitoringInterval?: Timeout;
    private readonly readingPaused = {reader: true, continuous_reader: true};
    private checking = false;
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
            this.master.sendToRole(role, {event: 'pause', source: 'queue-pressure'});
            this.readingPaused[role] = true;
        } else if (!aboveLimit && canResume && this.readingPaused[role]) {
            this.master.sendToRole(role, {event: 'resume', source: 'queue-pressure'});
            this.readingPaused[role] = false;
        }
    }

    private async checkQueues(autoscaleConsumers: Record<string, number>, limit: number) {
        if (this.checking) return;
        this.checking = true;
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
                throw new Error('Active reader input queue is not observed');
            }
            const pressure = {bulk: {above: false, resume: hasBulk}, live: {above: false, resume: hasLive}, shared: {above: false, resume: true}};
            for (const [queue, item] of queues) {
                const size = await this.manager.checkQueueSize(queue);
                if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid queue size for ${queue}`);
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
        } catch (error) {
            // Unknown queue pressure must not release either reader.
            this.updateReader('reader', true, false);
            this.updateReader('continuous_reader', true, false);
            hLog('Queue monitoring failed; readers paused:', error);
        } finally {
            this.checking = false;
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
