import { createAdapter } from "@socket.io/redis-adapter";
import { ABI, Name } from "@wharfkit/antelope";
import { randomUUID } from "crypto";
import { FastifyInstance } from "fastify";
import { Redis, RedisOptions } from "ioredis";
import { Server, Socket } from 'socket.io';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { App, TemplatedApp } from 'uWebSockets.js';
import { debugLog, hLog, sleep } from '../indexer/helpers/common_functions.js';
import {
    StreamActionsRequest,
    StreamDeltasRequest,
    StreamEvents,
    StreamRequest,
    StreamTypeMap
} from "../interfaces/stream-requests.js";
import {mergeActionMeta, streamPastCommon} from "./helpers/functions.js";
import {protectProtocolAction, protocolActionsForStream} from './helpers/protocol-abi.js';
import {createProtocolStreamScope} from './helpers/protocol-proof-request.js';
import {assertProtocolProjectionReady} from './helpers/protocol-state-readiness.js';
import {assertProtocolActionStreamReady} from './helpers/protocol-action-query.js';
import {normalizeActionSequences} from '../indexer/helpers/action-sequences.js';
import {
    checkActionFilters,
    checkDeltaFilters,
    processActionRequests,
    processTableRequests
} from "./helpers/streamFunctions.js";

export const maximumPendingLiveActions = 64;
export const maximumPendingLiveActionBytes = 16 * 1024 * 1024;

interface PendingLiveAction {
    trace: {account: string; name: string; notified: string; message: string};
    targets: Map<string, string[]>;
    bytes: number;
    done: () => void;
}

interface ActiveHistoryRequest {
    clientId: string;
    controller: AbortController;
    type: 'action' | 'delta';
    replayOnReconnect: boolean;
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
    // One chain-local FIFO preserves relay arrival order while proofs await storage.
    // The active item counts against both budgets; the relay cannot queue unlimited waiters.
    private liveActionQueue: PendingLiveAction[] = [];
    private liveActionPendingBytes = 0;
    private liveActionDraining = false;
    private historyRequests = new Map<string, ActiveHistoryRequest>();

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
    private payerClientMap: Map<string, Map<string, Map<string, StreamDeltasRequest>>> = new Map();

    // notifiedAccount >> client_id >> requestIds
    private notifiedAccountClientMap: Map<string, Map<string, Map<string, StreamActionsRequest>>> = new Map();

    private disconnectTimeoutMap: Map<string, NodeJS.Timeout> = new Map();
    private staleRelayClients = new Set<string>();
    private pendingRelayCancels = new Map<string, Set<string>>();

    private lastRelaySocketId: string = '';

    constructor(fastify: FastifyInstance, url: string, redisOptions: RedisOptions) {
        this.server = fastify;
        this.url = url;
        this.uwsApp = App({});

        // WS Server for public access
        this.io = new Server({ transports: ['websocket'], path: '/stream' });

        this.io.attachApp(this.uwsApp);
        this.chainId = this.server.manager.conn.chains[this.server.manager.chain].chain_id;
        const pubClient = new Redis(redisOptions);
        const subClient = pubClient.duplicate();

        this.io.adapter(createAdapter(pubClient, subClient, {
            key: this.chainId
        }));

        this.io.on('connection', (socket: Socket) => {
            this.handleSocketConnection(socket, fastify);
        });

        try {
            const port = this.server.manager.config.api.stream_port || 1234;
            this.uwsApp.listen(port, () => {
                // Extract the hostname and determine protocol from server_name
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
                        hostname = serverName.split(':')[0];
                    }
                } catch (e) {
                    // Fallback to server_addr if parsing fails
                    hostname = this.server.manager.config.api.server_addr;
                }
                // Log the complete WebSocket URL with the appropriate protocol
                hLog(`Stream API URL: ${wsProtocol}${hostname}:${port}/stream`);
            });
        } catch (e: any) {
            hLog(e.message);
        }

        hLog('Websocket manager loaded!');
    }

    private handleSocketConnection(socket: Socket, fastify: FastifyInstance) {
        if (socket.handshake.headers['x-forwarded-for']) {
            hLog(`[socket] ${socket.id} connected via ${socket.handshake.headers['x-forwarded-for']}`);
        }
        socket.emit('handshake', { chain: fastify.manager.chain, chain_id: this.chainId });
        if (this.relay) {
            this.relay.emit('event', { type: 'client_count', counter: this.io.sockets.sockets.size });
        }

        // handle reconnection and request reuse
        socket.on('reconnect', (data: any) => {
            if (data.last_id) {
                hLog("Client reconnected, previous ID: " + data.last_id);
                if (this.clientDeltaRequestMap.has(data.last_id) || this.clientActionRequestMap.has(data.last_id) ||
                    [...this.historyRequests.values()].some(request => request.clientId === data.last_id)) {
                    void this.replaceClientId(data.last_id, socket.id, socket).catch(error => {
                        hLog('Stream reconnect transfer failed:', error);
                        const requestIds = new Set([
                            ...(this.clientDeltaRequestMap.get(data.last_id)?.keys() ?? []),
                            ...(this.clientActionRequestMap.get(data.last_id)?.keys() ?? []),
                            ...(this.clientDeltaRequestMap.get(socket.id)?.keys() ?? []),
                            ...(this.clientActionRequestMap.get(socket.id)?.keys() ?? [])
                        ]);
                        for (const uuid of requestIds) {
                            this.cancelRelayRequest(socket.id, uuid);
                            this.detachDeltaRequests(socket.id, uuid);
                            this.detachActionRequests(socket.id, uuid);
                        }
                        this.detachDeltaRequests(data.last_id);
                        this.detachActionRequests(data.last_id);
                        this.retireRelayClient(data.last_id);
                        socket.emit('resend_requests', {last_id: data.last_id});
                    });
                } else {
                    // No requests present, likely a server restart, ask the client to resend the request
                    // Add a random delay
                    setTimeout(() => {
                        socket.emit('resend_requests', { last_id: data.last_id });
                    }, 1000 + Math.random() * 1000);
                }
            }
        });

        // handle request cancellation
        socket.on('cancel_stream_request', (data: { reqUUID: string }, callback) => {
            if (typeof callback !== 'function') return;
            if (typeof data?.reqUUID !== 'string' || !data.reqUUID)
                return callback({status: 'ERROR', message: 'Invalid request id'});
            const history = this.historyRequests.get(data.reqUUID);
            if (history && history.clientId !== socket.id) return callback({status: 'NOT_FOUND'});
            const delta = this.clientDeltaRequestMap.get(socket.id)?.has(data.reqUUID) ?? false;
            const action = this.clientActionRequestMap.get(socket.id)?.has(data.reqUUID) ?? false;
            if (!history && !delta && !action) return callback({status: 'NOT_FOUND'});
            history?.controller.abort(new Error('Stream request cancelled'));
            this.historyRequests.delete(data.reqUUID);
            if (delta) this.detachDeltaRequests(socket.id, data.reqUUID);
            if (action) this.detachActionRequests(socket.id, data.reqUUID);
            if (!delta && !action) return callback({status: 'OK'});
            this.cancelRelayRequest(socket.id, data.reqUUID, callback);
        });

        // handle delta stream request
        socket.on('delta_stream_request', async (data: StreamDeltasRequest, callback) => {
            this.processStreamRequest('delta', socket, data, callback).catch(reason => {
                return callback({ status: 'ERROR', message: reason });
            });
        });

        // handle action stream request
        socket.on('action_stream_request', async (data: StreamActionsRequest, callback) => {
            this.processStreamRequest('action', socket, data, callback).catch(reason => {
                return callback({ status: 'ERROR', message: reason });
            });
        });

        // handle client disconnection
        socket.on('disconnect', (reason) => {
            hLog(`[socket] ${socket.id} disconnected - ${reason}`);
            const timeoutId = setTimeout(() => {
                for (const [uuid, history] of this.historyRequests) if (history.clientId === socket.id) {
                    history.controller.abort(new Error('Stream client disconnected'));
                    this.historyRequests.delete(uuid);
                }
                this.detachDeltaRequests(socket.id);
                this.detachActionRequests(socket.id);
                if (this.relay) {
                    this.relay.emit('event', { type: 'client_disconnected', id: socket.id, reason });
                }
                this.disconnectTimeoutMap.delete(socket.id);
                // console.log("Pending requests: ", this.disconnectTimeoutMap.size);
            }, 5000);
            this.disconnectTimeoutMap.set(socket.id, timeoutId);
        });
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
            reconnection: true
        });

        this.relay.on('connect', () => {
            hLog('Relay Connected!');
            this.lastRelaySocketId = this.relay?.id || '';
            for (const clientId of this.staleRelayClients) {
                this.relay?.emit('event', {type: 'client_disconnected', id: clientId,
                    reason: 'offline_reconnect_cleanup'});
                this.staleRelayClients.delete(clientId);
            }
            this.flushPendingRelayCancels();
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
            void this.routeActionTraceToClients(traceData).catch(error => hLog('Action relay failed:', error));
        });

        this.relay.on('delta', (traceData) => {
            void this.routeDeltaToClients(traceData).catch(error => hLog('Delta relay failed:', error));
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

    // Send request from client to relay socket on indexer with callback
    private cancelRelayRequest(clientId: string, requestUUID: string,
        callback?: (response: any) => void): void {
        if (this.relay?.connected) {
            try {
                this.relay.emit('event', {type: 'cancel_request', client_socket_id: clientId,
                    reqUUID: requestUUID}, (response: any) => callback?.(response));
                return;
            } catch (error) {
                hLog('Stream relay cancellation failed:', error);
            }
        }
        if (!this.pendingRelayCancels.has(clientId)) this.pendingRelayCancels.set(clientId, new Set());
        this.pendingRelayCancels.get(clientId)!.add(requestUUID);
        callback?.({status: 'OK', pending: true});
    }

    private flushPendingRelayCancels(): void {
        if (!this.relay?.connected) return;
        const pending = [...this.pendingRelayCancels];
        this.pendingRelayCancels.clear();
        for (const [clientId, requests] of pending) {
            for (const requestUUID of requests) this.cancelRelayRequest(clientId, requestUUID);
        }
    }

    emitToRelay(request: StreamRequest, type: StreamEvents, socket: Socket, reqUUID: string, done: (r: any) => void) {
        let settled = false;
        const finish = (response: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            const result = response && typeof response === 'object' ? {...response} : {
                status: 'ERROR', error: {statusCode: 503, retryable: true,
                    message: String(response ?? 'Stream relay unavailable')}
            };
            done({...result, reqUUID, currentBlockNum: this.currentBlockNum});
        };
        const timeout = setTimeout(() => {
            finish('Stream relay acknowledgement timed out');
            this.cancelRelayRequest(socket.id, reqUUID);
        }, 5000);
        if (!this.relay?.connected) return finish('STREAMING_OFFLINE');
        try {
            this.relay.emit('event', {reqUUID, type, client_socket: socket.id, request}, finish);
        } catch (error) {
            finish(error);
        }
    }

    // process a single action request to attach to the maps
    private attachActionRequests(data: StreamActionsRequest, client_id: string, requestUUID: string) {
        assertProtocolActionStreamReady(this.server, data);
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
            const clients = this.notifiedAccountClientMap.get(data.account)!;
            if (!clients.has(client_id)) clients.set(client_id, new Map());
            clients.get(client_id)!.set(requestUUID, data);
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
            const clients = this.payerClientMap.get(data.payer)!;
            if (!clients.has(client_id)) clients.set(client_id, new Map());
            clients.get(client_id)!.set(requestUUID, data);
        }

        // include on the clientDeltaRequestMap as a reverse index
        if (!this.clientDeltaRequestMap.has(client_id)) {
            this.clientDeltaRequestMap.set(client_id, new Map());
        }

        this.clientDeltaRequestMap.get(client_id)?.set(requestUUID, data);
    }

    /**
     * remove all requests from the client_id from the deltaCodeMap and payerClientMap, use info from the reverse
     * index at clientDeltaRequestMap, also clean it if needed
     */
    private detachDeltaRequests(client_id: string, requestUUID?: string) {
        const clientRequests = this.clientDeltaRequestMap.get(client_id);
        if (!clientRequests) return;
        for (const uuid of requestUUID ? [requestUUID] : [...clientRequests.keys()]) {
            const data = clientRequests.get(uuid);
            if (!data) continue;
            if (data.code && data.table) {
                const tables = this.deltaCodeMap.get(data.code);
                const clients = tables?.get(data.table);
                const requests = clients?.get(client_id);
                requests?.delete(uuid);
                if (requests?.size === 0) clients?.delete(client_id);
                if (clients?.size === 0) tables?.delete(data.table);
                if (tables?.size === 0) this.deltaCodeMap.delete(data.code);
            }
            if (data.payer && !data.code && !data.table) {
                const clients = this.payerClientMap.get(data.payer);
                const requests = clients?.get(client_id);
                requests?.delete(uuid);
                if (requests?.size === 0) clients?.delete(client_id);
                if (clients?.size === 0) this.payerClientMap.delete(data.payer);
            }
            clientRequests.delete(uuid);
        }
        if (clientRequests.size === 0) this.clientDeltaRequestMap.delete(client_id);
    }

    private detachActionRequests(client_id: string, requestUUID?: string) {
        const clientRequests = this.clientActionRequestMap.get(client_id);
        if (!clientRequests) return;
        for (const uuid of requestUUID ? [requestUUID] : [...clientRequests.keys()]) {
            const data = clientRequests.get(uuid);
            if (!data) continue;
            if (data.contract && data.action) {
                const actions = this.actionContractMap.get(data.contract);
                const clients = actions?.get(data.action);
                const requests = clients?.get(client_id);
                requests?.delete(uuid);
                if (requests?.size === 0) clients?.delete(client_id);
                if (clients?.size === 0) actions?.delete(data.action);
                if (actions?.size === 0) this.actionContractMap.delete(data.contract);
            }
            if (data.account && !data.contract && !data.action) {
                const clients = this.notifiedAccountClientMap.get(data.account);
                const requests = clients?.get(client_id);
                requests?.delete(uuid);
                if (requests?.size === 0) clients?.delete(client_id);
                if (clients?.size === 0) this.notifiedAccountClientMap.delete(data.account);
            }
            clientRequests.delete(uuid);
        }
        if (clientRequests.size === 0) this.clientActionRequestMap.delete(client_id);
    }

    private async routeActionTraceToClients(traceData: any): Promise<void> {
        const { account: contract, name: action, notified } = traceData;
        const targetClients = new Map<string, string[]>();
        const notifiedAccounts = notified.split(',');

        // console.log(`Routing Action [${contract}::${action}] to clients... | Notified: ${notified}`);

        // Forward to CONTRACT/ACTION listeners
        if (this.actionContractMap.has(contract)) {
            const actionClientMap = this.actionContractMap.get(contract);
            if (actionClientMap) {
                // Direct action requests
                processActionRequests(actionClientMap, action, notifiedAccounts, traceData.message, targetClients);
                // Wildcard action requests
                processActionRequests(actionClientMap, "*", notifiedAccounts, traceData.message, targetClients);
            }
        }

        // Forward to NOTIFIED ACCOUNT listeners
        notifiedAccounts.forEach((account: string) => {
            if (this.notifiedAccountClientMap.has(account)) {
                this.notifiedAccountClientMap.get(account)?.forEach((requests, clientId) => {
                    requests.forEach((requestData, requestUUID) => {
                        if (!targetClients.has(clientId)) targetClients.set(clientId, []);
                        if (checkActionFilters(requestData, account, traceData.message))
                            targetClients.get(clientId)?.push(requestUUID);
                    });
                });
            }
        });

        for (const [clientId, requests] of targetClients) if (!requests.length) targetClients.delete(clientId);
        if (!targetClients.size) return Promise.resolve();
        if (this.server.manager.config.settings?.protocol?.provider !== 'extension') {
            try {
                const message = JSON.stringify(normalizeActionSequences(JSON.parse(traceData.message)));
                targetClients.forEach((requests, clientId) => this.io.sockets.sockets.get(clientId)?.emit('message', {
                    type: 'action_trace', mode: 'live', targets: requests, message
                }));
            } catch (error) {
                this.emitActionUnavailable(targetClients, error);
            }
            return;
        }

        // Snapshot mutable relay envelopes, retaining only bounded strings and selected targets.
        const trace = {account: contract, name: action, notified, message: traceData.message as string};
        const bytes = Buffer.byteLength(trace.message) + Buffer.byteLength(notified)
            + [...targetClients].reduce((total, [clientId, requests]) => total + clientId.length * 2 + requests.join().length * 2, 0);
        if (this.liveActionQueue.length >= maximumPendingLiveActions
            || bytes + this.liveActionPendingBytes > maximumPendingLiveActionBytes) {
            this.emitActionUnavailable(targetClients, Object.assign(new Error('Live action delivery is busy; retry from the last received block.'),
                {statusCode: 503, code: 'protocol_live_backlog'}));
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.liveActionQueue.push({trace, targets: targetClients, bytes, done: resolve});
            this.liveActionPendingBytes += bytes;
            if (!this.liveActionDraining) {
                this.liveActionDraining = true;
                void this.drainLiveActions().catch(error => hLog('Action delivery lane failed:', error));
            }
        });
    }

    private emitActionUnavailable(targets: Map<string, string[]>, error: any): void {
        targets.forEach((requests, clientId) => this.io.sockets.sockets.get(clientId)?.emit('message', {
            type: 'action_trace', mode: 'live', targets: requests,
            error: {statusCode: error.statusCode ?? 503, code: error.code, retryable: true, message: error.message}
        }));
    }

    private async drainLiveActions(): Promise<void> {
        try {
            while (this.liveActionQueue.length) {
                const pending = this.liveActionQueue[0];
                let activeProofScope: ReturnType<typeof createProtocolStreamScope> | undefined;
                try {
                    let message = pending.trace.message;
                    if (this.server.manager.config.settings?.protocol?.provider === 'extension') {
                        activeProofScope = createProtocolStreamScope([...pending.targets.keys()]
                            .map(clientId => this.io.sockets.sockets.get(clientId)).filter(socket => socket !== undefined));
                        const action = normalizeActionSequences(JSON.parse(message)), proofScope = activeProofScope.scope;
                        const notified = new Set([
                            ...(action.receipts ?? []).map((receipt: any) => receipt.receiver),
                            ...(action.act?.authorization ?? []).map((authorization: any) => authorization.actor)
                        ]);
                        const headerNotified = new Set(pending.trace.notified.split(','));
                        if (action.act?.account !== pending.trace.account || action.act?.name !== pending.trace.name
                            || notified.size !== headerNotified.size || [...notified].some(account => !headerNotified.has(account))) {
                            throw Object.assign(new Error('Action relay headers do not match the retained occurrence.'), {statusCode: 503});
                        }
                        mergeActionMeta(action, false, true);
                        await protectProtocolAction(this.server, proofScope, action);
                        delete action.protocol;
                        const [checked] = await protocolActionsForStream(this.server, proofScope, [action]);
                        message = JSON.stringify(checked);
                    }
                    pending.targets.forEach((requests, clientId) => this.io.sockets.sockets.get(clientId)?.emit('message', {
                        type: 'action_trace', mode: 'live', targets: requests, message
                    }));
                } catch (error) {
                    this.emitActionUnavailable(pending.targets, error);
                } finally {
                    activeProofScope?.dispose();
                    this.liveActionQueue.shift();
                    this.liveActionPendingBytes -= pending.bytes;
                    pending.done();
                }
            }
        } finally {
            this.liveActionDraining = false;
        }
    }

    private async routeDeltaToClients(traceData: any) {

        // const tRef = process.hrtime.bigint();
        const { code, table, payer, scope, message } = traceData;
        const targetClients = new Map<string, string[]>();
        // Forward to CODE/TABLE listeners
        if (this.deltaCodeMap.has(code)) {
            const tableClientMap = this.deltaCodeMap.get(code);
            if (tableClientMap) {
                // Direct table requests
                processTableRequests(tableClientMap, table, payer, scope, message, targetClients);
                // Wildcard table requests
                processTableRequests(tableClientMap, "*", payer, scope, message, targetClients);
            }
        }

        // Forward to PAYER listeners
        if (this.payerClientMap.has(payer)) {
            this.payerClientMap.get(payer)?.forEach((requests, clientId) => {
                requests.forEach((requestData, requestUUID) => {
                    if (!targetClients.has(clientId)) targetClients.set(clientId, []);
                    if (checkDeltaFilters(requestData, payer, message))
                        targetClients.get(clientId)?.push(requestUUID);
                });
            });
        }

        // console.log(`Routing Delta [${code}::${table}::${scope}][${payer}] to ${targetClients.size} clients`);
        // console.log(targetClients);
        // console.dir(this.deltaCodeMap, {depth: Infinity, colors: true});

        try {assertProtocolProjectionReady(this.server, 'row-history');}
        catch (error: any) {
            targetClients.forEach((reqs, clientId) => this.io.sockets.sockets.get(clientId)?.emit('message', {
                type: 'delta_trace', mode: 'live', targets: reqs,
                error: {statusCode: error.statusCode ?? 503, retryable: true, message: error.message}
            }));
            return;
        }
        if (targetClients.size > 0) {
            targetClients.forEach((reqs: string[], clientId: string) => {
                this.io.sockets.sockets.get(clientId)?.emit('message', {
                    type: 'delta_trace',
                    mode: 'live',
                    targets: reqs,
                    message: traceData.message
                });
            });
        }
        // console.log("Processing time: ", Number(process.hrtime.bigint() - tRef) / 1000000, "ms");
    }

    private retireRelayClient(clientId: string): void {
        if (this.relay?.connected) this.relay.emit('event', {type: 'client_disconnected',
            id: clientId, reason: 'reconnected'});
        else this.staleRelayClients.add(clientId);
    }

    private transferRelayClient(previousId: string, newId: string, retainedRequestIds: string[]): Promise<boolean> {
        return new Promise(resolve => {
            if (!this.relay?.connected) return resolve(false);
            let settled = false;
            const finish = (accepted: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(accepted);
            };
            const timeout = setTimeout(() => finish(false), 5000);
            try {
                this.relay.emit('event', {type: 'client_reconnected',
                    old_client_socket: previousId, client_socket: newId,
                    retained_request_ids: retainedRequestIds},
                (response: any) => finish(response?.status === 'OK'));
            } catch {
                finish(false);
            }
        });
    }

    private async replaceClientId(previousId: string, newId: string, socket: Socket): Promise<void> {
        const currentTimeout = this.disconnectTimeoutMap.get(previousId);
        if (currentTimeout) clearTimeout(currentTimeout);
        this.disconnectTimeoutMap.delete(previousId);
        const activeHistory = [...this.historyRequests].filter(([, request]) => request.clientId === previousId);
        for (const [uuid, request] of activeHistory) {
            request.controller.abort(new Error('Stream client reconnected during history replay'));
            this.historyRequests.delete(uuid);
        }
        const activeHistoryIds = new Set(activeHistory.map(([uuid]) => uuid));
        const delta = [...(this.clientDeltaRequestMap.get(previousId) ?? [])]
            .filter(([uuid, data]) => !data.replayOnReconnect && !activeHistoryIds.has(uuid));
        const action = [...(this.clientActionRequestMap.get(previousId) ?? [])]
            .filter(([uuid, data]) => !data.replayOnReconnect && !activeHistoryIds.has(uuid));
        const retainedIds = [...delta, ...action].map(([uuid]) => uuid);
        const transferred = await this.transferRelayClient(previousId, newId, retainedIds);
        if (transferred) {
            for (const [uuid, data] of delta) this.attachDeltaRequests(data, newId, uuid);
            for (const [uuid, data] of action) this.attachActionRequests(data, newId, uuid);
        }
        this.detachDeltaRequests(previousId);
        this.detachActionRequests(previousId);
        if (!transferred) {
            // The transfer may have committed while its acknowledgement was lost.
            for (const uuid of retainedIds) this.cancelRelayRequest(newId, uuid);
            this.retireRelayClient(previousId);
            socket.emit('resend_requests', {last_id: previousId});
            return;
        }
        for (const [uuid, request] of activeHistory) if (!request.replayOnReconnect)
            socket.emit('message', {type: `${request.type}_trace`, mode: 'history', reqUUID: uuid,
                error: {statusCode: 503, retryable: true,
                    message: 'Reconnect interrupted history replay; start a new request'}});
    }

    private async processStreamRequest<K extends keyof StreamTypeMap>(
        type: K,
        socket: Socket,
        data: StreamTypeMap[K]['request'],
        callback: (resp: any) => void
    ) {
        const originalCallback = callback;
        let acknowledged = false;
        let requestUUID = '';
        let historyController: AbortController | undefined;
        let liveAccepted = false;
        callback = response => {if (!acknowledged) {acknowledged = true; originalCallback(response);}};
        try {
            if (type === 'delta') assertProtocolProjectionReady(this.server, 'row-history');
            if (type === 'action') assertProtocolActionStreamReady(this.server, data as StreamActionsRequest);

            const validation = await this.validateRequest(data, type);
            if (validation.status === 'ERROR') {
                debugLog('Invalid request: ', data);
                return callback(validation);
            }

            debugLog(`Processing ${type.toUpperCase()} request:`, data);

            // generate random uuid for each request
            requestUUID = randomUUID();
            if (data.start_from && data.start_from !== 0) {
                historyController = new AbortController();
                this.historyRequests.set(requestUUID, {clientId: socket.id, controller: historyController,
                    type, replayOnReconnect: Boolean(data.replayOnReconnect)});
            }

            // get the last history block from the real time stream request
            let lastHistoryBlock = 0;
            if (!data.ignore_live) {

                if (type === 'delta') {
                    this.attachDeltaRequests(data as StreamDeltasRequest, socket.id, requestUUID);
                } else if (type === 'action') {
                    this.attachActionRequests(data as StreamActionsRequest, socket.id, requestUUID);
                }

                const liveStart = await new Promise<any>((resolve) => {
                    // start sending realtime data
                    const reqType = type === 'delta' ? 'delta_request' : 'action_request';
                    this.emitToRelay(data, reqType, socket, requestUUID, resolve);
                });
                callback(liveStart);
                if (liveStart.status !== 'OK') {
                    if (type === 'delta') this.detachDeltaRequests(socket.id, requestUUID);
                    else this.detachActionRequests(socket.id, requestUUID);
                    return;
                }
                liveAccepted = true;
                lastHistoryBlock = liveStart.currentBlockNum;
            } else {
                // if live data is ignored, immediately reply to the callback
                callback({ status: 'OK', reqUUID: requestUUID, currentBlockNum: this.currentBlockNum });
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

                const hStreamResult = await streamPastCommon(this.server, socket, requestUUID, data, type,
                    historyController?.signal);

                if (!hStreamResult.status) {
                    throw new Error(String(hStreamResult.error ?? 'History replay failed'));
                } else {
                    ltb = hStreamResult.lastTransmittedBlock;
                    let attempts = 1;

                    await sleep(1000);

                    while (ltb && ltb > 0 && lastHistoryBlock > ltb && attempts <= 3) {
                        hLog('Last transmitted block:', ltb, ' | Last history block:', lastHistoryBlock, ' | Attempts:', attempts);
                        attempts++;
                        hLog(`Performing ${type.toUpperCase()} fill request from ${ltb}...`);
                        data.start_from = (hStreamResult.lastTransmittedBlock ?? 0) + 1;
                        data.read_until = lastHistoryBlock;
                        historyController?.signal.throwIfAborted();
                        const r = await streamPastCommon(this.server, socket, requestUUID, data, type,
                            historyController?.signal);
                        if (!r.status) {
                            throw new Error(String(r.error ?? 'History fill failed'));
                        } else {
                            ltb = r.lastTransmittedBlock;
                            await sleep(500);
                        }
                    }
                    hLog(`✅ Done streaming past ${type.toUpperCase()}S at block ${ltb}`);

                    historyController?.signal.throwIfAborted();
                    socket.emit('message', {
                        type: 'history_end',
                        reqUUID: requestUUID,
                        mode: 'history',
                        message: { lastBlock: ltb }
                    });
                }
            }
        } catch (e: any) {
            if (historyController?.signal.aborted) return;
            if (liveAccepted) {
                if (type === 'delta') this.detachDeltaRequests(socket.id, requestUUID);
                else this.detachActionRequests(socket.id, requestUUID);
                this.cancelRelayRequest(socket.id, requestUUID);
            }
            hLog(`[processStreamRequest] Failed to process ${type.toUpperCase()} request:`, e.message);
            const error = {statusCode: e.statusCode ?? 503, retryable: true, message: e.message};
            if (acknowledged && requestUUID) socket.emit('message', {reqUUID: requestUUID,
                type: `${type}_trace`, mode: 'history', error});
            else callback({status: 'ERROR', ...error});
        } finally {
            if (requestUUID) this.historyRequests.delete(requestUUID);
        }
    }

    private async validateRequest<T extends keyof StreamTypeMap>(data: StreamTypeMap[T]["request"], type: T): Promise<{
        status: 'OK' | 'ERROR',
        message?: string,
        errorData?: any
    }> {
        // basic request validation
        switch (type) {
            case "action": {
                const actionData = data as StreamActionsRequest;

                // we should accept contract and action if account is not provided
                // if the account is provided we don't need contract and action enforcement
                if (!actionData.account && (!actionData.contract || !actionData.action)) {
                    return {
                        status: 'ERROR',
                        message: 'account or contract and action are required'
                    };
                }


                // validate contract name
                if (actionData.contract && Name.from(actionData.contract).toString() !== actionData.contract) {
                    return {
                        status: "ERROR",
                        message: `Invalid contract name: ${actionData.contract}`
                    };
                }

                // validate action name
                if (actionData.action && Name.from(actionData.action).toString() !== actionData.action) {
                    return {
                        status: "ERROR",
                        message: `Invalid action name: ${actionData.action}`
                    };
                }

                // validate account name
                if (actionData.account && Name.from(actionData.account).toString() !== actionData.account) {
                    return {
                        status: "ERROR",
                        message: `Invalid account name: ${actionData.account}`
                    };
                }

                break;
            }
            case "delta": {
                const deltaData = data as StreamDeltasRequest;
                if (!deltaData.code || !deltaData.table) {
                    return {
                        status: 'ERROR',
                        message: 'code and table are required'
                    };
                }

                if (Name.from(deltaData.table).toString() !== deltaData.table) {
                    return {
                        status: "ERROR",
                        message: `Invalid table name: ${deltaData.table}`
                    };
                }

                if (Name.from(deltaData.code).toString() !== deltaData.code) {
                    return {
                        status: "ERROR",
                        message: `Invalid code name: ${deltaData.code}`
                    };
                }

                if (Name.from(deltaData.scope).toString() !== deltaData.scope) {
                    return {
                        status: "ERROR",
                        message: `Invalid scope name: ${deltaData.scope}`
                    };
                }

                break;
            }
        }

        // validate range
        if ((data.start_from && data.start_from !== 0) && (data.read_until && data.read_until !== 0)) {
            if (data.start_from > data.read_until) {
                return {
                    status: 'ERROR',
                    message: 'start_from cannot be greater than read_until'
                };
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
                return {
                    status: 'ERROR',
                    message: `Multiple filters for the same field are not valid unless in OR mode. ${errCount} errors found`,
                    errorData: data.filters
                };
            }
        }

        let contract: string | undefined;
        if (type === 'action') {
            contract = (data as StreamActionsRequest).contract;
        } else if (type === 'delta') {
            contract = (data as StreamDeltasRequest).code;
        }

        // A current node ABI cannot validate a retained extension action's historical epoch.
        // Exact source/occurrence proofs qualify each delivered payload instead.
        if (contract && this.server.manager.config.settings?.protocol?.provider !== 'extension') {
            const abiData = await this.server.antelope.getAbi(contract);
            if (!abiData) {
                return {
                    status: 'ERROR',
                    message: `Contract ${contract} not found`
                };
            }
            const abi = ABI.from(abiData.abi);
            if (type === 'action') {
                const actionName = (data as StreamActionsRequest).action;
                const action = abi.actions.find(action => action.name.toString() === actionName);
                if (!action) {
                    return {
                        status: 'ERROR',
                        message: `Action ${actionName} not found in contract ${contract}`
                    };
                }
            } else if (type === 'delta') {
                const tableName = (data as StreamDeltasRequest).table;
                const tableDef = abi.tables.find(table => table.name.toString() === tableName);
                if (!tableDef) {
                    return {
                        status: 'ERROR',
                        message: `Table ${tableName} not found in contract ${contract}`
                    };
                }
            }
        }

        return { status: "OK" };
    }
}
