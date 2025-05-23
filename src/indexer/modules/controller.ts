import { randomUUID } from "node:crypto";
import { App, HttpRequest, HttpResponse, RecognizedString, TemplatedApp, WebSocket } from "uWebSockets.js";
import { HyperionWorkerDef } from "../../interfaces/hyperionWorkerDef.js";
import { hLog } from "../helpers/common_functions.js";
import { HyperionMaster } from "./master.js";

export class LocalHyperionController {

    private localController?: TemplatedApp;
    master: HyperionMaster;

    constructor(master: HyperionMaster) {
        this.master = master;
    }

    publish(topic: RecognizedString, data: any) {
        this.localController?.publish(topic, JSON.stringify(data));
    }

    createLocalController(controlPort: number) {
        const formatWorkerMap = () => {
            return this.master.workerMap.map((worker: HyperionWorkerDef) => {
                return {
                    worker_id: worker.worker_id,
                    worker_role: worker.worker_role,
                    queue: worker.queue,
                    local_id: worker.local_id,
                    worker_queue: worker.worker_queue,
                    live_mode: worker.live_mode
                };
            });
        };

        this.localController = App();
        this.localController.ws('/local', {
            open: (ws: WebSocket<any>) => {
                hLog(`Local controller connected!`);
            },
            message: (ws, msg) => {
                const buffer = Buffer.from(msg);
                const rawMessage = buffer.toString();
                try {
                    switch (rawMessage) {
                        case 'list_workers': {
                            ws.send(JSON.stringify(formatWorkerMap()));
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
                                case 'pause-indexer': {
                                    const mId = randomUUID();
                                    ws.subscribe(mId);
                                    // forward to the workers of type message.type
                                    this.master.workerMap.forEach((worker: HyperionWorkerDef) => {
                                        if (worker.wref && worker.type === message.type) {
                                            worker.wref.send({ event: 'pause-indexer', mId });
                                        }
                                    });
                                    break;
                                }
                                // resume all indexer workers
                                case 'resume-indexer': {
                                    this.master.workerMap.forEach((worker: HyperionWorkerDef) => {
                                        if (worker.wref && worker.type === message.type) {
                                            worker.wref.send({
                                                event: 'resume-indexer',
                                                mId: message.mId
                                            });
                                        }
                                    });
                                    break;
                                }
                                case 'start-indexer': {
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
                                case 'stop-indexer': {
                                    this.master.gracefulStop(result => {
                                        if (result.ack) {
                                            ws.send(JSON.stringify({
                                                event: 'indexer-stopped'
                                            }));
                                        }
                                    });
                                    break;
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
            close: () => {
                hLog(`Local controller disconnected!`);
            }
        });

        this.localController.get('/list_workers', (res: HttpResponse, req: HttpRequest) => {
            res.writeHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(formatWorkerMap()));
        });

        this.localController.listen(controlPort, (token) => {
            if (token) {
                hLog(`Local controller listening on port ${controlPort}`);
            }
        });
    }
}