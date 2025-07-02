import { randomUUID } from "node:crypto";
import { App, HttpRequest, HttpResponse, RecognizedString, TemplatedApp, WebSocket } from "uWebSockets.js";
import { HyperionWorkerDef } from "../../interfaces/hyperionWorkerDef.js";
import { hLog } from "../helpers/common_functions.js";
import { HyperionMaster } from "./master.js";

export interface WebSocketData {
    socketId: string;
}

export class LocalHyperionController {

    private localController?: TemplatedApp;
    master: HyperionMaster;

    sockets: Map<string, WebSocket<any>> = new Map();

    constructor(master: HyperionMaster) {
        this.master = master;
    }

    publish(topic: RecognizedString, data: any) {
        this.localController?.publish(topic, JSON.stringify(data));
    }

    formatWorkerMap() {
        return this.master.workerMap.map((worker: HyperionWorkerDef) => {
            return {
                worker_id: worker.worker_id,
                worker_role: worker.worker_role,
                queue: worker.queue,
                local_id: worker.local_id,
                worker_queue: worker.worker_queue,
                live_mode: worker.live_mode,
                failures: worker.failures || 0
            };
        });
    }

    /**
     * Sets up HTTP handlers for the local controller to manage Hyperion workers.
     * This includes endpoints for getting worker information, killing workers, and scaling parameters.
     */
    setHttpHandlers() {


        if (!this.localController) {
            throw new Error("Local controller is not initialized. Call createLocalController first.");
        }

        // Get the list of workers
        this.localController.get('/get_workers', (res: HttpResponse, req: HttpRequest) => {
            res.writeHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(this.formatWorkerMap()));
        });

        // Get worker info by worker_id
        this.localController.get('/get_worker/:worker_id', (res: HttpResponse, req: HttpRequest) => {
            const workerId = req.getParameter(0);

            if (!workerId) {
                res.writeStatus('400 Bad Request');
                res.end(JSON.stringify({ error: 'Worker ID is required.' }));
                return;
            }

            const workerIdNumber = parseInt(workerId, 10);
            if (isNaN(workerIdNumber)) {
                res.writeStatus('400 Bad Request');
                res.end(JSON.stringify({ error: 'Invalid Worker ID format. It should be a number.' }));
                return;
            }

            const worker = this.master.workerMap.find((w: HyperionWorkerDef) => w.worker_id === workerIdNumber);
            if (worker) {
                res.writeHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    worker_id: worker.worker_id,
                    worker_role: worker.worker_role,
                    last_processed_block: worker.worker_last_processed_block,
                    pid: worker.wref?.process.pid || null,
                    failures: worker.failures || 0,
                    killed: worker.wref?.process.killed || false
                }));
            } else {
                res.writeStatus('404 Not Found');
                res.end(JSON.stringify({ error: `Worker with ID ${workerId} not found.` }));
            }
        });

        // Kill a worker by worker_id
        this.localController.get('/kill_worker/:worker_id', (res: HttpResponse, req: HttpRequest) => {
            const workerId = req.getParameter(0);
            if (!workerId) {
                res.writeStatus('400 Bad Request');
                res.end(JSON.stringify({ error: 'Worker ID is required.' }));
                return;
            }
            const workerIdNumber = parseInt(workerId, 10);
            if (isNaN(workerIdNumber)) {
                res.writeStatus('400 Bad Request');
                res.end(JSON.stringify({ error: 'Invalid Worker ID format. It should be a number.' }));
                return;
            }
            const worker = this.master.workerMap.find((w: HyperionWorkerDef) => w.worker_id === workerIdNumber);
            if (worker) {
                if (worker.wref && worker.wref.process) {
                    worker.wref.process.kill();
                    res.writeHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                        message: `Worker with ID ${workerId} has been killed.`,
                        worker_id: worker.worker_id,
                        worker_role: worker.worker_role,
                        last_processed_block: worker.worker_last_processed_block,
                        pid: worker.wref.process.pid,
                        killed: worker.wref.process.killed
                    }));
                } else {
                    res.writeStatus('404 Not Found');
                    res.end(JSON.stringify({ error: `Worker with ID ${workerId} is not running.` }));
                }
            } else {
                res.writeStatus('404 Not Found');
                res.end(JSON.stringify({ error: `Worker with ID ${workerId} not found.` }));
            }
        });

        this.localController.get('/list_workers', (res: HttpResponse, req: HttpRequest) => {
            res.writeHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(this.formatWorkerMap()));
        });

        // Get scaling parameters and worker counts by type
        this.localController.get('/scaling', (res: HttpResponse, req: HttpRequest) => {
            const workerCounts: Record<string, number> = {};
            const workersByRole: Record<string, HyperionWorkerDef[]> = {};

            // Group workers by role and count them
            this.master.workerMap.forEach((worker: HyperionWorkerDef) => {
                const role = worker.worker_role || 'unknown';
                if (!workerCounts[role]) {
                    workerCounts[role] = 0;
                    workersByRole[role] = [];
                }
                workerCounts[role]++;
                workersByRole[role].push(worker);
            });

            const scalingInfo = {
                // Configuration scaling parameters
                config: {
                    readers: this.master.conf.scaling.readers,
                    ds_threads: this.master.conf.scaling.ds_threads,
                    ds_queues: this.master.conf.scaling.ds_queues,
                    ds_pool_size: this.master.conf.scaling.ds_pool_size,
                    indexing_queues: this.master.conf.scaling.indexing_queues,
                    ad_idx_queues: this.master.conf.scaling.ad_idx_queues,
                    dyn_idx_queues: this.master.conf.scaling.dyn_idx_queues,
                    max_autoscale: this.master.conf.scaling.max_autoscale,
                    auto_scale_trigger: this.master.conf.scaling.auto_scale_trigger,
                    batch_size: this.master.conf.scaling.batch_size,
                    max_queue_limit: this.master.conf.scaling.max_queue_limit,
                    block_queue_limit: this.master.conf.scaling.block_queue_limit,
                    routing_mode: this.master.conf.scaling.routing_mode
                },
                // Current worker counts by role
                current_workers: workerCounts,
                // Total active workers
                total_workers: this.master.workerMap.length,
                // Worker details by role
                workers_by_role: Object.keys(workersByRole).reduce((acc, role) => {
                    acc[role] = workersByRole[role].map(worker => ({
                        worker_id: worker.worker_id,
                        local_id: worker.local_id,
                        queue: worker.queue || worker.worker_queue,
                        live_mode: worker.live_mode,
                        failures: worker.failures || 0,
                        active: !!worker.wref && !worker.wref.process.killed
                    }));
                    return acc;
                }, {} as Record<string, any[]>)
            };

            res.writeHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(scalingInfo, null, 2));
        });
    }


    /**
     * Sets up WebSocket handlers for the local controller to manage Hyperion workers.
     * This includes handling messages for starting, stopping, and monitoring workers.
     */
    setWebSocketHandlers() {
        if (!this.localController) {
            throw new Error("Local controller is not initialized. Call createLocalController first.");
        }

        this.localController.ws('/local', {
            open: (ws: WebSocket<WebSocketData>) => {
                hLog(`Local controller connected!`);
                // Store the WebSocket connection in the sockets map
                const socketId = randomUUID();
                // Assign a unique socket ID to the WebSocket connection
                ws.getUserData().socketId = socketId;
                this.sockets.set(socketId, ws);
            },
            message: (ws: WebSocket<WebSocketData>, msg: ArrayBuffer) => {
                const buffer = Buffer.from(msg);
                const rawMessage = buffer.toString();
                try {
                    switch (rawMessage) {
                        case 'list_workers': {
                            ws.send(JSON.stringify(this.formatWorkerMap()));
                            break;
                        }
                        default: {
                            // parse messages as json
                            const message = JSON.parse(rawMessage);
                            switch (message.event) {
                                case `fill_missing_blocks`: {
                                    this.master.fillMissingBlocks(message.data, ws).catch(console.log);
                                    break;
                                }
                                case 'pause_indexer': {
                                    const mId = randomUUID();
                                    ws.subscribe(mId);
                                    // forward to the workers of type message.type
                                    this.master.workerMap.forEach((worker: HyperionWorkerDef) => {
                                        if (worker.wref && worker.type === message.type) {
                                            worker.wref.send({ event: 'pause_indexer', mId });
                                        }
                                    });
                                    break;
                                }
                                // resume all indexer workers
                                case 'resume_indexer': {
                                    this.master.workerMap.forEach((worker: HyperionWorkerDef) => {
                                        if (worker.wref && worker.type === message.type) {
                                            worker.wref.send({
                                                event: 'resume_indexer',
                                                mId: message.mId
                                            });
                                        }
                                    });
                                    break;
                                }
                                case 'start_indexer': {
                                    this.master.start().then((response) => {
                                        if (response.status) {
                                            ws.send(JSON.stringify({ event: 'indexer-started', message: 'Indexer has been started.' }));
                                        } else {
                                            ws.send(JSON.stringify({ event: 'indexer-start-failed', error: response.error || 'Unknown error starting indexer.' }));
                                        }
                                    }).catch(error => {
                                        console.error('Failed to start Hyperion Master via controller:', error);
                                        ws.send(JSON.stringify({ event: 'indexer-start-failed', error: error.message || 'Unknown error starting indexer.' }));
                                    });
                                    break;
                                }
                                case 'stop_indexer': {
                                    this.master.gracefulStop(result => {
                                        if (result.ack) {
                                            ws.send(JSON.stringify({
                                                event: 'indexer_stopped'
                                            }));
                                        }
                                    });
                                    break;
                                }
                                case 'get_memory_usage': {
                                    this.master.requestDataFromWorkers(
                                        {
                                            event: 'request_memory_usage'
                                        },
                                        'memory_report'
                                    ).then((value) => {
                                        ws.send(JSON.stringify({
                                            event: 'memory_usage',
                                            data: value
                                        }));
                                    });
                                    break;
                                }
                                case 'get_usage_map': {
                                    const now = Date.now();
                                    const timingMetadata = {
                                        lastUpdate: this.master.lastContractMonitoringUpdate,
                                        monitoringInterval: this.master.contractMonitoringIntervalMs,
                                        startTime: this.master.contractMonitoringStartTime,
                                        currentTime: now,
                                        timeSinceLastUpdate: this.master.lastContractMonitoringUpdate > 0
                                            ? now - this.master.lastContractMonitoringUpdate
                                            : null,
                                        nextUpdateIn: this.master.lastContractMonitoringUpdate > 0
                                            ? Math.max(0, this.master.contractMonitoringIntervalMs - (now - this.master.lastContractMonitoringUpdate))
                                            : null
                                    };

                                    const loadDistributionPeriod = {
                                        intervalMs: this.master.contractMonitoringIntervalMs,
                                        lastCycleDurationMs: this.master.lastDistributionDurationMs,
                                        averageCycleDurationMs: this.master.averageDistributionDurationMs,
                                        totalCycles: this.master.distributionCycleCount,
                                        totalProcessingTimeMs: this.master.totalDistributionTimeMs,
                                        performanceRatio: this.master.lastDistributionDurationMs > 0
                                            ? (this.master.lastDistributionDurationMs / this.master.contractMonitoringIntervalMs * 100).toFixed(2) + '%'
                                            : null,
                                        isHealthy: this.master.lastDistributionDurationMs < (this.master.contractMonitoringIntervalMs * 0.1), // Healthy if < 10% of interval
                                        uptime: this.master.contractMonitoringStartTime > 0
                                            ? now - this.master.contractMonitoringStartTime
                                            : 0
                                    };

                                    ws.send(JSON.stringify({
                                        event: 'usage_map',
                                        data: this.master.globalUsageMap,
                                        timing: timingMetadata,
                                        loadDistributionPeriod: loadDistributionPeriod
                                    }));
                                    break;
                                }
                                case 'get_heap': {
                                    this.master.requestDataFromWorkers(
                                        {
                                            event: 'request_v8_heap_stats'
                                        },
                                        'v8_heap_report'
                                    ).then((value) => {
                                        ws.send(JSON.stringify({
                                            event: 'v8_heap_report',
                                            data: value
                                        }));
                                    });
                                    break;
                                }
                                case 'reload_contract_config': {
                                    const contract = message.data?.contract;
                                    if (!contract) {
                                        ws.send(JSON.stringify({
                                            event: 'contract_config_reload_failed',
                                            error: 'No contract specified for reload.'
                                        }));
                                        return;
                                    }
                                    this.master.reloadContractConfig(contract).then((result) => {
                                        if (result.success) {
                                            ws.send(JSON.stringify({
                                                event: 'contract_config_reloaded',
                                                message: 'Contract configuration reloaded successfully.'
                                            }));
                                        } else {
                                            ws.send(JSON.stringify({
                                                event: 'contract_config_reload_failed',
                                                error: result.error || 'Unknown error reloading contract configuration.'
                                            }));
                                        }
                                    });
                                }
                                default: {
                                    hLog(`Unknown message type: ${message.event}`);
                                }
                            }
                        }
                    }
                } catch (e: any) {
                    console.error(e);
                    ws.send(JSON.stringify({ error: e.message }));
                    ws.send('Invalid message format!');
                    ws.end();
                }
            },
            close: (ws: WebSocket<WebSocketData>) => {
                // Handle WebSocket disconnection
                const socketId = ws.getUserData().socketId;
                if (socketId) {
                    this.sockets.delete(socketId);
                    hLog(`Local controller disconnected!`);
                    this.master.connectedController = undefined;
                } else {
                    hLog(`WebSocket closed without a valid socket ID.`);
                }
            }
        });
    }

    /**
     * Creates the local controller for managing Hyperion workers and handling requests.
     * @param controlPort The port on which the local controller will listen for WebSocket connections.
     */
    createLocalController(controlPort: number) {

        if (this.localController) {
            throw new Error("Local controller is already initialized. Call createLocalController only once.");
        }
        if (!controlPort || controlPort <= 0 || controlPort > 65535) {
            throw new Error("Invalid control port specified. It must be a number between 1 and 65535.");
        }

        // Initialize the local controller app
        this.localController = App();

        this.setHttpHandlers();
        this.setWebSocketHandlers();

        // Start listening on the specified control port
        this.localController.listen(controlPort, (token) => {
            if (token) {
                hLog(`Local controller listening on port ${controlPort}`);
            }
        });
    }
}