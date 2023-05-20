import {hLog, sleep} from '../helpers/common_functions';
import {Server, Socket} from 'socket.io';
import {createAdapter} from 'socket.io-redis';
import {io} from 'socket.io-client';
import {FastifyInstance} from "fastify";
import IORedis from "ioredis";
import {App, TemplatedApp} from 'uWebSockets.js';
import {streamPastActions, streamPastDeltas} from "./helpers/functions";
import {randomUUID} from "crypto";

export interface StreamDeltasRequest {
    code: string;
    table: string;
    scope: string;
    payer: string;
    start_from: number | string;
    read_until: number | string;
}

export interface RequestFilter {
    field: string;
    value: string;
}

export interface StreamActionsRequest {
    contract: string;
    account: string;
    action: string;
    filters: RequestFilter[];
    start_from: number | string;
    read_until: number | string;
}


export class SocketManager {

    private io: Server;
    private relay;
    relay_restored = true;
    relay_down = false;
    private readonly url;
    private readonly server: FastifyInstance;
    private readonly uwsApp: TemplatedApp;
    private chainId: string;
    private currentBlockNum: number;

    constructor(fastify: FastifyInstance, url, redisOptions) {
        this.server = fastify;
        this.url = url;
        this.uwsApp = App({});

        // WS Server for public access
        this.io = new Server({
            transports: ['websocket'],
            path: '/stream'
        });

        this.io.attachApp(this.uwsApp);

        this.chainId = this.server.manager.conn.chains[this.server.manager.chain].chain_id
        hLog(`[SocketManager] chain_id: ${this.chainId}`);
        const pubClient = new IORedis(redisOptions);
        const subClient = pubClient.duplicate();
        this.io.adapter(createAdapter({pubClient, subClient, key: this.chainId}));

        this.io.on('connection', (socket: Socket) => {

            if (socket.handshake.headers['x-forwarded-for']) {
                hLog(`[socket] ${socket.id} connected via ${socket.handshake.headers['x-forwarded-for']}`);
            }

            socket.emit('message', {
                event: 'handshake',
                chain: fastify.manager.chain,
            });

            if (this.relay) {
                this.relay.emit('event', {
                    type: 'client_count',
                    counter: this.io.sockets.sockets.size,
                });
            }

            socket.on('delta_stream_request', async (data: StreamDeltasRequest, callback) => {
                if (typeof callback === 'function' && data) {
                    try {
                        if (data.start_from) {
                            const hStreamResult = await streamPastDeltas(this.server, socket, data);
                            if (hStreamResult === false) {
                                return;
                            }
                        }
                        this.emitToRelay(data, 'delta_request', socket, callback);
                    } catch (e) {
                        console.log(e);
                    }
                }
            });

            socket.on('action_stream_request', async (data: StreamActionsRequest, callback) => {
                if (typeof callback === 'function' && data) {
                    try {
                        // generate random uuid
                        socket.data.reqUUID = randomUUID();

                        const lastHistoryBlock = await new Promise<number>((resolve) => {
                            // start sending realtime data
                            this.emitToRelay(data, 'action_request', socket, (emissionResult) => {
                                callback(emissionResult);
                                resolve(emissionResult.currentBlockNum);
                            });
                        });

                        // push history data
                        if (data.start_from) {
                            data.read_until = lastHistoryBlock;
                            console.log('Performing primary scroll request...');
                            let ltb;
                            const hStreamResult = await streamPastActions(this.server, socket, data);
                            if (hStreamResult.status === false) {
                                return;
                            } else {
                                ltb = hStreamResult.lastTransmittedBlock;
                                let attempts = 0;
                                await sleep(500);
                                while (lastHistoryBlock > ltb && attempts < 3) {
                                    attempts++;
                                    console.log(`Performing fill request from ${hStreamResult.lastTransmittedBlock}...`);
                                    data.start_from = hStreamResult.lastTransmittedBlock + 1;
                                    data.read_until = lastHistoryBlock;
                                    const r = await streamPastActions(this.server, socket, data);
                                    if (r.status === false) {
                                        console.log(r);
                                        return;
                                    } else {
                                        ltb = r.lastTransmittedBlock;
                                    }
                                }
                            }
                        }

                    } catch (e) {
                        console.log(e);
                    }
                }
            });

            socket.on('disconnect', (reason) => {
                hLog(`[socket] ${socket.id} disconnected - ${reason}`);
                this.relay.emit('event', {
                    type: 'client_disconnected',
                    id: socket.id,
                    reason,
                });
            });
        });

        try {
            const port = this.server.manager.config.api.stream_port || 1234;
            this.uwsApp.listen(port, () => {
                hLog(`Socket.IO via uWS started on port ${port}`);
            });
        } catch (e) {
            hLog(e.message);
        }

        hLog('Websocket manager loaded!');
    }

    /*
    WS Relay will connect to the indexer
     */
    startRelay() {
        hLog(`starting relay - ${this.url}`);
        this.relay = io(this.url, {path: '/router'});

        this.relay.on('connect', () => {
            hLog('Relay Connected!');
            if (this.relay_down) {
                this.relay_restored = true;
                this.relay_down = false;
                this.io.emit('status', 'relay_restored');
            }
        });

        this.relay.on('disconnect', () => {
            hLog('Relay disconnected!');
            this.io.emit('status', 'relay_down');
            this.relay_down = true;
            this.relay_restored = false;
        });

        this.relay.on('delta', (traceData) => {
            this.emitToClient(traceData, 'delta_trace');
        });

        this.relay.on('trace', (traceData) => {
            this.emitToClient(traceData, 'action_trace');
        });

        this.relay.on('block', (blockData) => {
            try {
                // const decodedBlock = JSON.parse(blockData.content.toString());
                // console.log(blockData.serverTime, blockData.blockNum, decodedBlock);
                this.currentBlockNum = blockData.blockNum;
            } catch (e) {
                hLog(`Failed to decode incoming live block ${blockData.blockNum}: ${e.message}`);
            }
        });

        this.addRelayForwarding('lib_update');

        this.addRelayForwarding('fork_event');

        // // Relay LIB info to clients;
        // this.relay.on('lib_update', (data) => {
        //     if (this.server.manager.conn.chains[this.server.manager.chain].chain_id === data.chain_id) {
        //         this.io.emit('lib_update', data);
        //     }
        // });
        //
        // // Relay fork info to clients;
        // this.relay.on('fork_event', (data) => {
        //     if (this.server.manager.conn.chains[this.server.manager.chain].chain_id === data.chain_id) {
        //         this.io.emit('fork_event', data);
        //     }
        // });
    }

    // Relay events to clients
    addRelayForwarding(event: string) {
        this.relay.on(event, (data: any) => {
            if (data.chain_id && this.chainId === data.chain_id) {
                this.io.emit(event, data);
            }
        });
    }

    emitToClient(traceData, type) {
        if (this.io.sockets.sockets.has(traceData.client)) {
            this.io.sockets.sockets.get(traceData.client).emit('message', {
                type: type,
                reqUUID: traceData.req,
                mode: 'live',
                message: traceData.message,
            });
        }
    }

    emitToRelay(data, type, socket, callback) {
        if (this.relay.connected) {
            this.relay.emit('event', {
                reqUUID: socket.data.reqUUID,
                type: type,
                client_socket: socket.id,
                request: data,
            }, (response) => {
                response['reqUUID'] = socket.data.reqUUID;
                response['currentBlockNum'] = this.currentBlockNum;
                callback(response);
            });
        } else {
            callback('STREAMING_OFFLINE');
        }
    }
}
