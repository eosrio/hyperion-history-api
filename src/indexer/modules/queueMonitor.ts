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
    private readingPaused = false;
    chain: string;

    constructor(master: HyperionMaster) {
        this.master = master;
        this.conf = this.master.conf;
        this.chain = this.master.chain;
        this.manager = this.master.manager;
    }

    private pauseReaders() {
        if (!this.readingPaused) {
            this.master.sendToRole('reader', { event: 'pause' });
            this.readingPaused = true;
        }
    }

    private resumeReaders() {
        if (this.readingPaused) {
            this.master.sendToRole('reader', { event: 'resume' });
            this.readingPaused = false;
        }
    }

    private async checkQueues(autoscaleConsumers: Record<string, number>, limit: number) {
        const testedQueues = new Set();
        let aboveLimit = false;
        let canResume = true;
        let queuedMessages = 0;
        for (const worker of this.master.workerMap) {
            let queue = worker.queue;
            if (!queue) {
                queue = worker.worker_queue;
            }

            if (worker.worker_role === 'ds_pool_worker') {
                queue = `${this.chain}:ds_pool:${worker.local_id}`;
            }

            if (queue && !testedQueues.has(queue)) {
                const size = await this.manager.checkQueueSize(queue);
                queuedMessages += size;
                let qlimit = this.conf.scaling.max_queue_limit;
                if (worker.worker_role === 'deserializer') {
                    qlimit = this.conf.scaling.block_queue_limit;
                }

                // if (size / qlimit > 0.5) {
                // 	hLog(queue, size, ((size / qlimit) * 100).toFixed(2) + "%");
                // }

                // pause readers if queues are above the max_limit
                if (size >= qlimit) {
                    aboveLimit = true;
                }

                // check if any queue is above resume point
                if (size >= this.conf.scaling.resume_trigger) {
                    canResume = false;
                }

                // check indexing queues
                if (worker.worker_role === 'ingestor') {
                    if (size > limit) {
                        if (!autoscaleConsumers[queue]) {
                            autoscaleConsumers[queue] = 0;
                        }
                        if (autoscaleConsumers[queue] < this.conf.scaling.max_autoscale) {
                            hLog(`${queue} is above the limit (${size}/${limit}). Launching consumer...`);
                            this.master.addWorker({
                                queue: queue,
                                type: worker.type,
                                worker_role: 'ingestor'
                            });
                            this.master.launchWorkers();
                            autoscaleConsumers[queue]++;
                        }
                    }
                }

                // // resume readers if the queues are below the trigger point
                // if (size <= this.conf.scaling.resume_trigger) {
                //
                // 	// remove flow limiter
                // 	if (this.readingLimited) {
                // 		this.readingLimited = false;
                // 		hLog('removing flow limiters');
                // 		for (const worker of this.workerMap) {
                // 			if (worker.worker_role === 'reader') {
                // 				worker.wref.send({event: 'set_delay', data: {state: false, delay: 0}});
                // 			}
                // 		}
                // 	}
                //
                // 	// fully unpause
                // 	if (this.readingPaused) {
                // 		canResume = true;
                // 		this.readingPaused = false;
                // 		hLog('resuming readers');
                // 		for (const worker of this.workerMap) {
                // 			if (worker.worker_role === 'reader') {
                // 				worker.wref.send({event: 'pause'});
                // 			}
                // 		}
                // 	}
                // }
                //
                // // apply block processing delay on 80% usage
                // if (size >= this.conf.scaling.max_queue_limit * 0.8) {
                // 	this.readingLimited = true;
                // 	hLog('applying flow limiters');
                // 	for (const worker of this.workerMap) {
                // 		if (worker.worker_role === 'reader') {
                // 			worker.wref.send({event: 'set_delay', data: {state: true, delay: 250}});
                // 		}
                // 	}
                // }

                testedQueues.add(queue);
            }
        }

        if (aboveLimit) {

            this.pauseReaders();

        } else {

            if (canResume) {
                this.resumeReaders();
            }

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