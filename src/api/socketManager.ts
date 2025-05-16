import {checkMetaFilter, hLog, sleep} from '../indexer/helpers/common_functions.js';
import {Server, Socket} from 'socket.io';
import {createAdapter} from "@socket.io/redis-adapter";
import {io, Socket as ClientSocket} from 'socket.io-client';
import {FastifyInstance} from "fastify";
import {Redis, RedisOptions} from "ioredis";
import {App, TemplatedApp} from 'uWebSockets.js';
import {streamPastActions, streamPastDeltas} from "./helpers/functions.js";
import {randomUUID} from "crypto";
import {RequestFilter, StreamActionsRequest, StreamDeltasRequest} from "../interfaces/stream-requests.js";

function processActionRequests(
    actionClientMap: Map<string, Map<string, Map<string, StreamActionsRequest>>>,
    actionName: string,
    account: string,
    message: string,
    targetClients: Map<string, string[]>
): void {
    if (!actionClientMap.has(actionName)) return;
    actionClientMap.get(actionName)?.forEach((requests, clientId) => {
        // console.log(requests);

        if (!targetClients.has(clientId)) {
            targetClients.set(clientId, []);
        }

        requests.forEach((request, uuid) => {
            if (checkActionFilters(request, account, message)) {
                targetClients.get(clientId)?.push(uuid);
            }
        });
    });
}

function processTableRequests(
    tableClientMap: Map<string, Map<string, Map<string, StreamDeltasRequest>>>,
    tableId: string,
    payer: string,
    message: string,
    targetClients: Map<string, string[]>
): void {
    if (!tableClientMap.has(tableId)) return;
    tableClientMap.get(tableId)?.forEach((requests, clientId) => {

        // console.log(requests);

        if (!targetClients.has(clientId)) {
            targetClients.set(clientId, []);
        }

        requests.forEach((request, uuid) => {
            if (checkDeltaFilters(request, payer, message)) {
                targetClients.get(clientId)?.push(uuid);
            }
        });
    });
}

function checkActionFilters(request: StreamActionsRequest, account: string, msg: string): boolean {
    let allow: boolean;
    if (request.account) {
        allow = request.account === account;
    } else {
        allow = true;
    }
    if (allow && request.filters && request.filters?.length > 0) {
        const parsedMsg = JSON.parse(msg);
        if (request.filter_op === 'or') {
            allow = request.filters.some((f: RequestFilter) => checkMetaFilter(f, parsedMsg, 'action'));
        } else {
            allow = request.filters.every((f: RequestFilter) => checkMetaFilter(f, parsedMsg, 'action'));
        }
    }
    return allow;
}

function checkDeltaFilters(request: StreamDeltasRequest, payer: string, msg: string): boolean {
    let allow: boolean;
    if (request.payer) {
        allow = request.payer === payer;
    } else {
        allow = true;
    }
    if (allow && request.filters && request.filters?.length > 0) {
        const parsedMsg = JSON.parse(msg);
        if (request.filter_op === 'or') {
            allow = request.filters.some((f: RequestFilter) => checkMetaFilter(f, parsedMsg, 'delta'));
        } else {
            allow = request.filters.every((f: RequestFilter) => checkMetaFilter(f, parsedMsg, 'delta'));
        }
    }
    return allow;
}

export class SocketManager {

    private io: Server;
    private relay?: ClientSocket;
    relay_restored = true;
    relay_down = false;
    private readonly url: string;
    private readonly server: FastifyInstance;
    private readonly uwsApp: TemplatedApp;
    private readonly chainId: string;
    private currentBlockNum = 0;

    // client_id >> request_uuid >> delta request
    private clientDeltaRequestMap: Map<string, Map<string, StreamDeltasRequest>> = new Map();

    // client_id >> request_uuid >> action request
    private clientActionRequestMap: Map<string, Map<string, StreamActionsRequest>> = new Map();

    // code >> table >> client_id >> [requests]
    private deltaCodeMap: Map<string, Map<string, Map<string, Map<string, StreamDeltasRequest>>>> = new Map();

    // contract >> action >> client_id >> [requests]
    private actionContractMap: Map<string, Map<string, Map<string, Map<string, StreamActionsRequest>>>> = new Map();

    // request_uuid >> client_id
    // private requestClientMap: Map<string, string> = new Map();

    // payer >> client_id >> request_uuid
    private payerClientMap: Map<string, Map<string, [string, StreamDeltasRequest]>> = new Map();

    // notifiedAccount >> client_id >> requestIds
    private notifiedAccountClientMap: Map<string, Map<string, [string, StreamActionsRequest]>> = new Map();


    private disconnectTimeoutMap: Map<string, NodeJS.Timeout> = new Map();
    private lastRelaySocketId: string = '';

    constructor(fastify: FastifyInstance, url: string, redisOptions: RedisOptions) {
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
        const pubClient = new Redis(redisOptions);
        const subClient = pubClient.duplicate();

        this.io.adapter(createAdapter(pubClient, subClient, {
            key: this.chainId
        }));

        this.io.on('connection', (socket: Socket) => {

            // special event to handle reconnection and request reuse
            socket.on('reconnect', (data: any) => {
                if (data.last_id) {
                    hLog("Client reconnected, previous ID: " + data.last_id);
                    if (this.clientDeltaRequestMap.has(data.last_id)) {
                        this.replaceClientId(data.last_id, socket.id);
                    } else {
                        // No requests present, likely a server restart, ask the client to resend the request
                        // Add a random delay
                        setTimeout(() => {
                            socket.emit('resend_requests', {last_id: data.last_id});
                        }, 1000 + Math.random() * 1000);
                    }
                }
            });

            if (socket.handshake.headers['x-forwarded-for']) {
                hLog(`[socket] ${socket.id} connected via ${socket.handshake.headers['x-forwarded-for']}`);
            }

            socket.emit('handshake', {chain: fastify.manager.chain, chain_id: this.chainId});

            if (this.relay) {
                this.relay.emit('event', {type: 'client_count', counter: this.io.sockets.sockets.size});
            }

            socket.on('cancel_stream_request', (data: { reqUUID: string }, callback) => {
                console.log('cancel_stream_request', data);
                if (typeof callback === 'function' && data) {
                    try {
                        if (this.relay && this.relay.connected) {
                            this.relay.emit('event', {
                                reqUUID: data.reqUUID,
                                type: 'cancel_request',
                                client_socket_id: socket.id,
                            }, (response: any) => {
                                callback(response);
                            });
                        } else {
                            callback('STREAMING_OFFLINE');
                        }
                    } catch (e: any) {
                        console.log(e);
                    }
                }
            })

            socket.on('delta_stream_request', async (data: StreamDeltasRequest, callback) => {
                if (typeof callback === 'function' && data) {
                    try {

                        // basic request validation
                        if (!data.code || !data.table) {
                            return callback({
                                status: 'ERROR',
                                message: 'code and table are required'
                            });
                        }

                        // validate range
                        if ((data.start_from && data.start_from !== 0) && (data.read_until && data.read_until !== 0)) {
                            if (data.start_from > data.read_until) {
                                return callback({
                                    status: 'ERROR',
                                    message: 'start_from cannot be greater than read_until'
                                });
                            }
                        }

                        // check filters
                        if (data.filters && data.filter_op !== "or") {
                            // multiple filters for the same field are not valid unless in OR mode
                            const filterFields = new Set<string>();
                            let errCount = 0;
                            data.filters.forEach(value => {
                                if (filterFields.has(value.field)) {
                                    errCount++;
                                } else {
                                    filterFields.add(value.field);
                                }
                            });
                            if (errCount > 0) {
                                return callback({
                                    status: 'ERROR',
                                    message: `Multiple filters for the same field are not valid unless in OR mode. ${errCount} errors found`,
                                    errorData: data.filters
                                });
                            }
                        }

                        // generate random uuid for each request
                        const requestUUID = randomUUID();
                        // debug only
                        // this.prettyDeltaRoutingMap();
                        // this.printRoutingTable()

                        // get the last history block from the real time stream request
                        let lastHistoryBlock = 0;
                        if (!data.ignore_live) {
                            this.attachDeltaRequests(data, socket.id, requestUUID);
                            lastHistoryBlock = await new Promise<number>((resolve) => {
                                // start sending realtime data
                                this.emitToRelay(data, 'delta_request', socket, requestUUID, (emissionResult) => {
                                    callback(emissionResult);
                                    resolve(emissionResult.currentBlockNum);
                                });
                            });
                        } else {
                            // if live data is ignored immediately reply the callback
                            callback({status: 'OK', reqUUID: requestUUID, currentBlockNum: this.currentBlockNum});
                        }

                        // push history data (optional)
                        if (data.start_from && data.start_from !== 0) {

                            if (!(data.read_until && data.read_until !== 0)) {
                                if (lastHistoryBlock > 0) {
                                    data.read_until = lastHistoryBlock;
                                }
                            }

                            hLog('Performing primary scroll request until block: ', data.read_until, '... ');
                            let ltb: number | undefined = 0;
                            const hStreamResult = await streamPastDeltas(this.server, socket, requestUUID, data);
                            if (!hStreamResult.status) {
                                return;
                            } else {
                                ltb = hStreamResult.lastTransmittedBlock;
                                let attempts = 0;
                                await sleep(500);
                                while (ltb && ltb > 0 && lastHistoryBlock > ltb && attempts < 3) {
                                    attempts++;
                                    hLog(`Performing fill request from ${ltb}...`);
                                    data.start_from = (hStreamResult.lastTransmittedBlock ?? 0) + 1;
                                    data.read_until = lastHistoryBlock;
                                    const r = await streamPastDeltas(this.server, socket, requestUUID, data);
                                    if (!r.status) {
                                        console.log("Error streaming past data:", r);
                                        return;
                                    } else {
                                        ltb = r.lastTransmittedBlock;
                                    }
                                }
                                hLog(`Done streaming past data at block ${ltb} Emitting event to client...`);
                                socket.emit('message', {
                                    type: 'delta_history_end',
                                    reqUUID: requestUUID,
                                    mode: 'history',
                                    message: {lastBlock: ltb},
                                });
                            }
                        }

                    } catch (e: any) {
                        console.log(e);
                    }
                }
            });

            socket.on('action_stream_request', async (data: StreamActionsRequest, callback) => {
                if (typeof callback === 'function' && data) {
                    try {

                        console.log(data);

                        // basic request validation
                        if (!data.contract || !data.action) {
                            return callback({
                                status: 'ERROR',
                                message: 'contract or action are required'
                            });
                        }

                        // validate range
                        if ((data.start_from && data.start_from !== 0) && (data.read_until && data.read_until !== 0)) {
                            if (data.start_from > data.read_until) {
                                return callback({
                                    status: 'ERROR',
                                    message: 'start_from cannot be greater than read_until'
                                });
                            }
                        }

                        // check filters
                        if (data.filters && data.filter_op !== "or") {
                            // multiple filters for the same field are not valid unless in OR mode
                            const filterFields = new Set<string>();
                            let errCount = 0;
                            data.filters.forEach(value => {
                                if (filterFields.has(value.field)) {
                                    errCount++;
                                } else {
                                    filterFields.add(value.field);
                                }
                            });
                            if (errCount > 0) {
                                return callback({
                                    status: 'ERROR',
                                    message: `Multiple filters for the same field are not valid unless in OR mode. ${errCount} errors found`,
                                    errorData: data.filters
                                });
                            }
                        }

                        // generate random uuid for each request
                        const requestUUID = randomUUID();

                        // get the last history block from the real time stream request
                        let lastHistoryBlock: string | number = 0;
                        if (!data.ignore_live) {
                            this.attachActionRequests(data, socket.id, requestUUID);
                            lastHistoryBlock = await new Promise<number>((resolve) => {
                                // start sending realtime data
                                this.emitToRelay(data, 'action_request', socket, requestUUID, (emissionResult) => {
                                    callback(emissionResult);
                                    resolve(emissionResult.currentBlockNum);
                                });
                            });
                        } else {
                            // if live data is ignored immediately reply the callback
                            console.log("Ignoring live data for action stream request...");
                            lastHistoryBlock = data.read_until;
                            callback({status: 'OK', reqUUID: requestUUID, currentBlockNum: this.currentBlockNum});
                        }

                        // await sleep(2000);

                        // push history data
                        if (data.start_from) {
                            data.read_until = lastHistoryBlock;
                            console.log('Performing primary scroll request...');
                            await streamPastActions(this.server, socket, requestUUID, data);

                            // let ltb: number | undefined = 0;
                            // const hStreamResult = await streamPastActions(this.server, socket, requestUUID, data);
                            // if (!hStreamResult.status) {
                            //     return;
                            // } else {
                            //     ltb = hStreamResult.lastTransmittedBlock;
                            //     let attempts = 0;
                            //     await sleep(1500);
                            //     while (ltb && ltb > 0 && lastHistoryBlock > ltb && attempts < 3) {
                            //         attempts++;
                            //         console.log(`Performing fill request from ${hStreamResult.lastTransmittedBlock}...`);
                            //         data.start_from = (hStreamResult.lastTransmittedBlock ?? 0) + 1;
                            //         data.read_until = lastHistoryBlock;
                            //         const r = await streamPastActions(this.server, socket, requestUUID, data);
                            //         if (!r.status) {
                            //             console.log(r);
                            //             return;
                            //         } else {
                            //             ltb = r.lastTransmittedBlock;
                            //         }
                            //     }
                            // }

                        }
                    } catch (e: any) {
                        console.log(e);
                    }
                }
            });


            socket.on('disconnect', (reason) => {
                hLog(`[socket] ${socket.id} disconnected - ${reason}`);
                const timeoutId = setTimeout(() => {
                    this.detachDeltaRequests(socket.id);
                    if (this.relay) {
                        this.relay.emit('event', {type: 'client_disconnected', id: socket.id, reason});
                    }
                    this.disconnectTimeoutMap.delete(socket.id);
                    // console.log("Pending requests: ", this.disconnectTimeoutMap.size);
                }, 5000);
                this.disconnectTimeoutMap.set(socket.id, timeoutId);
            });
        });

        try {
            const port = this.server.manager.config.api.stream_port || 1234;
            const serverName = this.server.manager.config.api.server_name.split(':')[0];
            this.uwsApp.listen(port, () => {

                // Extract hostname and determine protocol from server_name
                let hostname = '127.0.0.1';
                let wsProtocol = 'ws://'; // Default to non-secure WebSocket
                try {
                    const serverName = this.server.manager.config.api.server_name;
                    if (serverName.includes('://')) {
                        const url = new URL(serverName);
                        hostname = url.hostname;
                        // If the server is using HTTPS, use secure WebSockets (WSS)
                        if (url.protocol === 'https:') {
                            wsProtocol = 'wss://';
                        }
                    } else {
                        // Handle simple hostname:port format
                        hostname = serverName.split(':')[0];
                    }
                } catch (e) {
                    // Fallback to server_addr if parsing fails
                    hostname = this.server.manager.config.api.server_addr;
                }

                // Log the complete WebSocket URL with appropriate protocol
                hLog(`Stream API URL: ${wsProtocol}${hostname}:${port}/stream`);

            });
        } catch (e: any) {
            hLog(e.message);
        }

        hLog('Websocket manager loaded!');
    }

    /*
    WS Relay will connect to the indexer
     */
    startRelay() {
        hLog(`starting relay - ${this.url}`);
        this.relay = io(this.url, {
            path: '/router',
            extraHeaders: {
                'x-last-relay-id': this.lastRelaySocketId
            },
            reconnection: true,
        });

        this.relay.on('connect', () => {
            hLog('Relay Connected!');
            this.lastRelaySocketId = this.relay?.id || '';
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

        this.relay.on('action', (traceData) => {
            this.routeActionTraceToClients(traceData);
        });

        this.relay.on('delta', (traceData) => {
            this.routeDeltaToClients(traceData);
        });

        // update local current block info from relay
        this.relay.on('block', (blockData) => {
            try {
                this.currentBlockNum = blockData.blockNum;
            } catch (e: any) {
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

    // Add event broadcasting handlers
    addRelayForwarding(event: string) {
        if (this.relay) {
            this.relay.on(event, (data: any) => {
                if (data.chain_id && this.chainId === data.chain_id) {
                    this.io.emit(event, data);
                }
            });
        }
    }

    // Send request from client to relay socket on indexer
    emitToRelay(
        data: StreamActionsRequest | StreamDeltasRequest,
        type: string,
        socket: Socket,
        requestUUID: string,
        callback: (response: any) => void
    ) {
        if (this.relay && this.relay.connected) {
            this.relay.emit('event', {
                reqUUID: requestUUID,
                type: type,
                client_socket: socket.id,
                request: data,
            }, (response: any) => {
                response['reqUUID'] = requestUUID;
                response['currentBlockNum'] = this.currentBlockNum;
                callback(response);
            });
        } else {
            callback('STREAMING_OFFLINE');
        }
    }

    // process a single action request to attach to the maps
    private attachActionRequests(data: StreamActionsRequest, client_id: string, requestUUID: string) {
        if (data.contract && data.action) {

            if (!this.actionContractMap.has(data.contract)) {
                this.actionContractMap.set(data.contract, new Map());
            }

            if (!this.actionContractMap.get(data.contract)?.has(data.action)) {
                this.actionContractMap.get(data.contract)?.set(data.action, new Map());
            }

            if (!this.actionContractMap.get(data.contract)?.get(data.action)?.has(client_id)) {
                this.actionContractMap.get(data.contract)?.get(data.action)?.set(client_id, new Map());
            }

            const actionRequests = this.actionContractMap.get(data.contract)?.get(data.action)?.get(client_id);
            actionRequests?.set(requestUUID, data);
        }

        if (data.account && !data.contract && !data.action) {
            if (!this.notifiedAccountClientMap.has(data.account)) {
                this.notifiedAccountClientMap.set(data.account, new Map());
            }
            this.notifiedAccountClientMap.get(data.account)?.set(client_id, [requestUUID, data]);
        }

        // include on the clientDeltaRequestMap as reverse index
        if (!this.clientActionRequestMap.has(client_id)) {
            this.clientActionRequestMap.set(client_id, new Map());
        }
        this.clientActionRequestMap.get(client_id)?.set(requestUUID, data);
    }

    // process a single delta request to attach to the maps
    private attachDeltaRequests(data: StreamDeltasRequest, client_id: string, requestUUID: string) {
        if (data.code && data.table) {

            if (!this.deltaCodeMap.has(data.code)) {
                this.deltaCodeMap.set(data.code, new Map());
            }

            if (!this.deltaCodeMap.get(data.code)?.has(data.table)) {
                this.deltaCodeMap.get(data.code)?.set(data.table, new Map());
            }

            if (!this.deltaCodeMap.get(data.code)?.get(data.table)?.has(client_id)) {
                this.deltaCodeMap.get(data.code)?.get(data.table)?.set(client_id, new Map());
            }

            const deltaRequests = this.deltaCodeMap.get(data.code)?.get(data.table)?.get(client_id);
            deltaRequests?.set(requestUUID, data);
        }

        if (data.payer && !data.code && !data.table) {
            if (!this.payerClientMap.has(data.payer)) {
                this.payerClientMap.set(data.payer, new Map());
            }
            this.payerClientMap.get(data.payer)?.set(client_id, [requestUUID, data]);
        }

        // include on the clientDeltaRequestMap as reverse index
        if (!this.clientDeltaRequestMap.has(client_id)) {
            this.clientDeltaRequestMap.set(client_id, new Map());
        }
        this.clientDeltaRequestMap.get(client_id)?.set(requestUUID, data);
    }

    // function to display the full request map this.deltaCodeMap
    private prettyDeltaRoutingMap() {
        console.log(`-------- CODE-TABLE-CLIENT MAP --------------`);
        this.deltaCodeMap.forEach((codeMap, code) => {
            console.log("Code: ", code, " ->");
            codeMap.forEach((tableMap, table) => {
                console.log("Table: ", table, " ->");
                tableMap.forEach((clientMap, client) => {
                    console.log("Client: ", client, " ->");
                    clientMap.forEach((request, requestUUID) => {
                        console.log(`requestUUID: ${requestUUID}, request: ${JSON.stringify(request, null, 2)}`);
                    });
                });
            });
        });
        console.log(`-------- PAYER-CLIENT MAP --------------`);
        let totalClients = 0;
        this.payerClientMap.forEach((clientSet, payer) => {
            console.log("Payer: ", payer, " ->");
            clientSet.forEach((client) => {
                console.log("Client: ", client);
                totalClients++;
            });
        });
        console.log(`Total clients: ${totalClients}`);
    }

    private prettyPrintPayerClientMap() {
        console.log(`-------------------------------`);
        this.payerClientMap.forEach((clientSet, payer) => {
            console.log("Payer: ", payer, " ->");
            clientSet.forEach((client) => {
                console.log("Client: ", client);
            });
        })
    }

    /**
     * remove all requests from the client_id from the deltaCodeMap and payerClientMap, use info from the reverse
     * index at clientDeltaRequestMap, also clean it if needed
     */
    private detachDeltaRequests(client_id: string) {
        const clientRequests = this.clientDeltaRequestMap.get(client_id);
        if (clientRequests) {
            clientRequests?.forEach((data, requestUUID) => {
                // console.log(`>> Removing request (${requestUUID}) | Code: ${data.code} | Table: ${data.table} | Payer: ${data.payer}`);
                if (data.code && data.table) {
                    // Remove from deltaCodeMap
                    const tableMap = this.deltaCodeMap.get(data.code)?.get(data.table);
                    if (tableMap) {
                        tableMap.delete(client_id);
                        // Clean up empty maps
                        if (tableMap.size === 0) {
                            this.deltaCodeMap.get(data.code)?.delete(data.table);
                            if (this.deltaCodeMap.get(data.code)?.size === 0) {
                                this.deltaCodeMap.delete(data.code);
                            }
                        }
                    }
                }
                if (data.payer) {
                    // Remove from payerClientMap
                    const clientSet = this.payerClientMap.get(data.payer);
                    if (clientSet) {
                        clientSet.delete(client_id);
                        if (clientSet.size === 0) {
                            this.payerClientMap.delete(data.payer);
                        }
                    }
                }
            });
            // Clean up clientDeltaRequestMap
            this.clientDeltaRequestMap.delete(client_id);
        }
    }

    private detachActionRequests(client_id: string) {
        const clientRequests = this.clientActionRequestMap.get(client_id);
        if (clientRequests) {
            clientRequests?.forEach((data, requestUUID) => {
                // console.log(`>> Removing request (${requestUUID}) | contract: ${data.contract} | action: ${data.action}`);
                if (data.contract && data.action) {
                    // Remove from actionContractMap
                    const actionMap = this.actionContractMap.get(data.contract)?.get(data.action);
                    if (actionMap) {
                        actionMap.delete(client_id);
                        // Clean up empty maps
                        if (actionMap.size === 0) {
                            this.actionContractMap.get(data.contract)?.delete(data.action);
                            if (this.actionContractMap.get(data.contract)?.size === 0) {
                                this.actionContractMap.delete(data.contract);
                            }
                        }
                    }
                }

                if (data.account) {
                    // Remove from payerClientMap
                    const clientSet = this.payerClientMap.get(data.account);
                    if (clientSet) {
                        clientSet.delete(client_id);
                        if (clientSet.size === 0) {
                            this.payerClientMap.delete(data.account);
                        }
                    }
                }
            });
            // Clean up clientDeltaRequestMap
            this.clientDeltaRequestMap.delete(client_id);
        }
    }

    /**
     * Print a table with the number of clients attached to each code-table routing path
     */
    private printRoutingTable() {
        console.log(`-------- CODE-TABLE-CLIENT MAP --------------`);
        const data: any[] = [];
        this.deltaCodeMap.forEach((codeMap, code) => {
            codeMap.forEach((tableMap, table) => {
                data.push({code, table, clients: tableMap.size});
            })
        });
        console.table(data);
        console.log(`-------- PAYER-CLIENT MAP --------------`);
        const data2: any[] = [];
        this.payerClientMap.forEach((clientSet, payer) => {
            data2.push({payer, clients: clientSet.size});
        });
        console.table(data2);
    }

    private routeActionTraceToClients(traceData: any) {
        const {account: contract, name: action, notified} = traceData;
        const targetClients = new Map<string, string[]>();
        const notifiedAccounts = notified.split(',');
        
        // console.log(`Routing Action [${contract}::${action}] to clients... | Notified: ${notified}`);

        // Forward to CONTRACT/ACTION listeners
        if (this.actionContractMap.has(contract)) {
            const actionClientMap = this.actionContractMap.get(contract);
            if (actionClientMap) {
                // Process specific action requests
                processActionRequests(actionClientMap, action, notifiedAccounts, traceData.message, targetClients);
                // Process wildcard action requests
                processActionRequests(actionClientMap, "*", notifiedAccounts, traceData.message, targetClients);
            }
        }

        // Forward to NOTIFIED ACCOUNT listeners
        notifiedAccounts.forEach((account) => {
            if (this.notifiedAccountClientMap.has(account)) {
                this.notifiedAccountClientMap.get(account)?.forEach(([requestUUID, requestData], clientId) => {
                    if (!targetClients.has(clientId)) {
                        targetClients.set(clientId, []);
                    }
                    if (checkActionFilters(requestData, account, traceData.message)) {
                        targetClients.get(clientId)?.push(requestUUID);
                    }
                });
            }
        });

        targetClients.forEach((reqs: string[], clientId: string) => {
            this.io.sockets.sockets.get(clientId)?.emit('message', {
                type: 'action_trace',
                mode: 'live',
                targets: reqs,
                message: traceData.message,
            });
        });

    }

    private routeDeltaToClients(traceData: any) {

        // const tRef = process.hrtime.bigint();
        const {code, table, payer, scope, message} = traceData;
        const targetClients = new Map<string, string[]>();
        // Forward to CODE/TABLE listeners
        if (this.deltaCodeMap.has(code)) {
            const tableClientMap = this.deltaCodeMap.get(code);
            if (tableClientMap) {
                // Process specific table requests
                processTableRequests(tableClientMap, table, payer, message, targetClients);
                // Process wildcard table requests
                processTableRequests(tableClientMap, "*", payer, message, targetClients);
            }
        }

        // Forward to PAYER listeners
        if (this.payerClientMap.has(payer)) {
            this.payerClientMap.get(payer)?.forEach(([requestUUID, requestData], clientId) => {
                if (!targetClients.has(clientId)) {
                    targetClients.set(clientId, []);
                }
                if (checkDeltaFilters(requestData, payer, message)) {
                    targetClients.get(clientId)?.push(requestUUID);
                }
            });
        }
        
        // console.log(`Routing Delta [${code}::${table}::${scope}][${payer}] to ${targetClients.size} clients`);

        targetClients.forEach((reqs: string[], clientId: string) => {
            this.io.sockets.sockets.get(clientId)?.emit('message', {
                type: 'delta_trace',
                mode: 'live',
                targets: reqs,
                message: traceData.message,
            });
        });
        // console.log("Processing time: ", Number(process.hrtime.bigint() - tRef) / 1000000, "ms");
    }

    private replaceClientId(previousId: string, newId: string) {
        const currentTimeout = this.disconnectTimeoutMap.get(previousId);
        if (currentTimeout) {
            clearTimeout(currentTimeout);
        }
        const currentDeltaRequests = this.clientDeltaRequestMap.get(previousId);
        if (currentDeltaRequests) {
            console.log('⚠️ currentDeltaRequests:', currentDeltaRequests);
            currentDeltaRequests.forEach((data, requestUUID) => {
                if (!data.replayOnReconnect) {
                    this.attachDeltaRequests(data, newId, requestUUID);
                }
            });
            this.detachDeltaRequests(previousId);
            this.clientDeltaRequestMap.set(newId, currentDeltaRequests);
            this.clientDeltaRequestMap.delete(previousId);
        }

        const currentActionRequests = this.clientActionRequestMap.get(previousId);
        if (currentActionRequests) {
            console.log('⚠️ currentActionRequests:', currentActionRequests);
            currentActionRequests.forEach((data, requestUUID) => {
                if (!data.replayOnReconnect) {
                    this.attachActionRequests(data, newId, requestUUID);
                }
            });
            this.detachActionRequests(previousId);
            this.clientActionRequestMap.set(newId, currentActionRequests);
            this.clientActionRequestMap.delete(previousId);
        }

    }
}
