import {ConsumeMessage} from "amqplib";
import {createServer} from "http";
import {Server, Socket} from "socket.io";
import {ActionLink, DeltaLink} from "../../interfaces/stream-links.js";
import {StreamActionsRequest, StreamDeltasRequest, StreamMessage} from "../../interfaces/stream-requests.js";
import {RabbitQueueDef} from "../definitions/index-queues.js";
import {hLog} from "../helpers/common_functions.js";
import {HyperionWorker} from "./hyperionWorker.js";

interface TrackedRequest {
    type: string;
    firstBlock: number | null;
    lastBlock: number | null;
    relay_id: string;
    request: StreamActionsRequest | StreamDeltasRequest;
    added_on: number;
}

interface ClientInfo {
    relayId: string;
    requests: Map<string, TrackedRequest>;
}

export default class WSRouter extends HyperionWorker {

    q: string;
    totalRoutedMessages = 0;
    firstData = false;
    relays: Record<string, any> = {};

    activeRequests = new Map();
    private io?: Server;
    private totalClients = 0;

    // reverse index for clients
    private clientMap: Map<string, ClientInfo> = new Map();

    // code >> table >> relayId >> requestIds
    private codeTableRelayMap: Map<string, Map<string, Map<string, Set<string>>>> = new Map();

    // contract >> action >> relayId >> requestIds
    private contractActionRelayMap: Map<string, Map<string, Map<string, Set<string>>>> = new Map();

    // payer >> relayId >> requestIds
    private payerRelayMap: Map<string, Map<string, Set<string>>> = new Map();

    // notifiedAccount >> relayId >> requestIds
    private notifiedRelayMap: Map<string, Map<string, Set<string>>> = new Map();

    constructor() {
        super();
        this.q = this.chain + ':stream';
        this.activeRequests.set('*', {
            sockets: []
        });
    }

    async assertQueues(): Promise<void> {
        if (this.ch) {
            await this.ch.assertQueue(this.q, RabbitQueueDef);
            await this.ch.consume(this.q, this.onConsume.bind(this));
        }
    }

    appendIdAndEmit(event: string, data: any) {
        this.io?.emit(event, {
            chain_id: this.manager.conn.chains[this.chain]?.chain_id,
            ...data
        });
    };

    onIpcMessage(msg: any): void {
        switch (msg.event) {
            case 'lib_update': {
                this.appendIdAndEmit('lib_update', msg.data);
                break;
            }
            case 'fork_event': {
                this.appendIdAndEmit('fork_event', msg.data);
                break;
            }
        }
    }

    async run(): Promise<void> {
        this.initRoutingServer();
        this.startRoutingRateMonitor();
        return undefined;
    }

    onConsume(msg: ConsumeMessage | null) {

        if (!this.firstData) {
            this.firstData = true;
        }

        // push to plugin handlers
        this.mLoader.processStreamEvent(msg);

        if (msg && msg.properties.headers) {
            // process incoming live messages
            switch (msg.properties.headers.event) {

                // Block Messages
                case 'block': {
                    // forward block events to all APIs
                    this.io?.of('/').emit('block', {
                        serverTime: Date.now(),
                        blockNum: msg.properties.headers.blockNum,
                        content: msg.content
                    });
                    break;
                }

                // Action Trace Messages
                case 'trace': {
                    this.routeActionTraceMessage(msg);
                    break;
                }

                // Delta Trace Messages
                case 'delta': {
                    this.routeDeltaMessage(msg);
                    break;
                }

                default: {
                    console.log('Unidentified message!');
                    console.log(msg);
                }
            }
        }

        if (msg) {
            this.ch?.ack(msg);
        }
    }

    /**
     *  Route action trace messages to the appropriate relays
     *  based on the contract, action, and notified accounts.
     *  This function checks the headers of the message to determine
     *  the target relays and emits the message to those relays.
     * @param msg
     * @returns
     */
    private routeActionTraceMessage(msg: ConsumeMessage) {
        if (!msg.properties.headers) {
            return;
        }
        const targetRelays = new Set<string>();
        const actHeaders = msg.properties.headers;
        const contract = actHeaders.account;
        const action = actHeaders.name;
        const notified = actHeaders.notified.split(',');

        // Forward to CONTRACT/ACTION listeners
        if (this.contractActionRelayMap.has(contract)) {
            const actionRelayMap = this.contractActionRelayMap.get(contract);
            if (actionRelayMap) {
                // Send specific action
                if (actionRelayMap.has(action)) {
                    actionRelayMap.get(action)?.forEach((_, key) => targetRelays.add(key));
                }
                // Send any action
                if (actionRelayMap.has("*")) {
                    actionRelayMap.get("*")?.forEach((_, key) => targetRelays.add(key));
                }
            }
        }

        // Forward to NOTIFIED listeners
        notified.forEach((acct: string) => {
            if (this.notifiedRelayMap.has(acct)) {
                this.notifiedRelayMap.get(acct)?.forEach((_, key) => targetRelays.add(key));
            }
        });

        this.emitToTargetRelays('action', targetRelays, msg);
    }

    /**
     * Route delta messages to the appropriate relays
     * based on the code, table, and payer.
     * This function checks the headers of the message to determine
     * the target relays and emits the message to those relays.
     * @param msg
     * @returns
     */
    private routeDeltaMessage(msg: ConsumeMessage) {
        if (!msg.properties.headers) {
            return;
        }
        const targetRelays = new Set<string>();
        const {code, table, payer} = msg.properties.headers;

        // Forward to CODE/TABLE listeners
        if (this.codeTableRelayMap.has(code)) {
            const tableRelayMap = this.codeTableRelayMap.get(code);
            if (tableRelayMap) {
                // Send specific table
                if (tableRelayMap.has(table)) {
                    tableRelayMap.get(table)?.forEach((_, key) => targetRelays.add(key));
                }
                // Send any table
                if (tableRelayMap.has("*")) {
                    tableRelayMap.get("*")?.forEach((_, key) => targetRelays.add(key));
                }
            }
        }

        // Forward to PAYER listeners
        if (this.payerRelayMap.has(payer)) {
            this.payerRelayMap.get(payer)?.forEach((_, key) => targetRelays.add(key));
        }

        this.emitToTargetRelays('delta', targetRelays, msg);
    }

    /**
     * Emit the message to the target relays
     * @param eventType
     * @param targetRelays
     * @param msg
     */
    private emitToTargetRelays(eventType: string, targetRelays: Set<string>, msg: ConsumeMessage) {
        for (const relay_id of targetRelays.values()) {
            // console.log(`[Stream Router] Emitting ${eventType} to relay ${relay_id}`);
            const relay_socket = this.io?.of('/').sockets.get(relay_id);
            if (relay_socket) {
                relay_socket.emit(eventType, {
                    ...msg.properties.headers,
                    message: msg.content
                });
                this.totalRoutedMessages++;
            } else {
                hLog("Relay socket not found: ", relay_id);
                this.removeRelayLinks(relay_id);
            }
        }
    }

    /**
     * Start a monitor to log the routing rate every 20 seconds
     */
    startRoutingRateMonitor() {
        setInterval(() => {
            if (this.totalRoutedMessages > 0) {
                hLog('[Stream Router] Routing rate: ' + (this.totalRoutedMessages / 20) + ' msg/s');
                this.totalRoutedMessages = 0;
            }
        }, 20000);
    }

    /**
     * Count the total number of clients connected to the relays
     */
    countClients() {
        let total = 0;
        for (let key in this.relays) {
            if (this.relays.hasOwnProperty(key)) {
                if (this.relays[key].connected) {
                    total += this.relays[key].clients;
                }
            }
        }
        this.totalClients = total;
        hLog('Total WS clients:', this.totalClients);
    }

    /**
     * Add an action request to the router
     * @param data
     * @param relay_id
     * @returns
     */
    addActionRequest(data: StreamMessage<StreamActionsRequest>, relay_id: string) {

        const req: StreamActionsRequest = data.request;

        // check if the client has any request
        if (!this.clientMap.has(data.client_socket)) {
            this.clientMap.set(data.client_socket, {
                relayId: relay_id,
                requests: new Map()
            });
        }

        // get client ref
        const client = this.clientMap.get(data.client_socket);

        // create tracked request indexed by the request UUID
        client?.requests.set(data.reqUUID, {
            type: 'action',
            request: req,
            lastBlock: null,
            firstBlock: null,
            added_on: Date.now(),
            relay_id: relay_id
        });

        const {contract, action, account} = req;

        console.log("Incoming Action Request for contract: ", contract, " action: ", action, " account: ", account);

        if (contract && action) {
            if (!this.contractActionRelayMap.has(contract)) {
                this.contractActionRelayMap.set(contract, new Map());
            }
            if (!this.contractActionRelayMap.get(contract)?.has(action)) {
                this.contractActionRelayMap.get(contract)?.set(action, new Map());
            }
            if (!this.contractActionRelayMap.get(contract)?.get(action)?.has(relay_id)) {
                this.contractActionRelayMap.get(contract)?.get(action)?.set(relay_id, new Set());
            }
            this.contractActionRelayMap.get(contract)?.get(action)?.get(relay_id)?.add(data.reqUUID);
        }

        if (!contract && !action && account) {
            if (!this.notifiedRelayMap.has(account)) {
                this.notifiedRelayMap.set(account, new Map());
            }
            if (!this.notifiedRelayMap.get(account)?.has(relay_id)) {
                this.notifiedRelayMap.get(account)?.set(relay_id, new Set());
            }
            this.notifiedRelayMap.get(account)?.get(relay_id)?.add(data.reqUUID);
        }

        this.printActionClientTable();

        return {status: 'OK'};
    }

    /**
     * Add a delta request to the router
     * @param data
     * @param relay_id
     * @returns
     */
    addDeltaRequest(data: StreamMessage<StreamDeltasRequest>, relay_id: string) {
        const req: StreamDeltasRequest = data.request;

        // check if the client has any request
        if (!this.clientMap.has(data.client_socket)) {
            this.clientMap.set(data.client_socket, {
                relayId: relay_id,
                requests: new Map()
            });
        }

        // get client ref
        const client = this.clientMap.get(data.client_socket);

        // create tracked request indexed by the request UUID
        client?.requests.set(data.reqUUID, {
            type: 'delta',
            request: req,
            lastBlock: null,
            firstBlock: null,
            added_on: Date.now(),
            relay_id: relay_id
        });

        const {code, table, payer} = req;

        console.log("Incoming Delta Request with code: ", code, " table: ", table, " payer: ", payer);

        if (code && table) {
            if (!this.codeTableRelayMap.has(code)) {
                this.codeTableRelayMap.set(code, new Map());
            }
            if (!this.codeTableRelayMap.get(code)?.has(table)) {
                this.codeTableRelayMap.get(code)?.set(table, new Map());
            }
            if (!this.codeTableRelayMap.get(code)?.get(table)?.has(relay_id)) {
                this.codeTableRelayMap.get(code)?.get(table)?.set(relay_id, new Set());
            }
            this.codeTableRelayMap.get(code)?.get(table)?.get(relay_id)?.add(data.reqUUID);
        }

        if (!code && !table && payer) {
            if (!this.payerRelayMap.has(payer)) {
                this.payerRelayMap.set(payer, new Map());
            }
            if (!this.payerRelayMap.get(payer)?.has(relay_id)) {
                this.payerRelayMap.get(payer)?.set(relay_id, new Set());
            }
            this.payerRelayMap.get(payer)?.get(relay_id)?.add(data.reqUUID);
        }

        this.printDeltaClientTable();

        return {status: 'OK'};
    }

    removeDeepLinks(map: Map<string, any>, path: string[], relay_id: string, id: string, reqUUID?: string) {
        if (map.has(path[0])) {
            console.log("Removing deep links...", path);
            if (map.get(path[0]).has(path[1])) {
                const currentLinks = map.get(path[0]).get(path[1]).links;
                console.log(`currentLinks [${path}]`, currentLinks);
                currentLinks.forEach((item: ActionLink | DeltaLink, index: number) => {
                    console.log(`ReqUUID: ${reqUUID} | Relay: ${relay_id} | Client: ${id}`);
                    if ((reqUUID && item.reqUUID === reqUUID) || (item.relay === relay_id && item.client === id)) {
                        currentLinks.splice(index, 1);
                        console.log("Removed!");
                    }
                });
            }
        }
    }

    removeSingleLevelLinks(map: Map<string, any>, path: string[], key: string, id: string, reqUUID?: string) {
        if (map.has(path[2])) {
            console.log("Removing single level links...", path);
            const _links = map.get(path[2]).links;
            _links.forEach((item: ActionLink | DeltaLink, index: number) => {
                if ((reqUUID && item.reqUUID === reqUUID) || (item.relay === key && item.client === id)) {
                    _links.splice(index, 1);
                }
            });
        }
    }

    initRoutingServer() {

        const server = createServer();

        // Internal server for ROUTER-RELAY sockets
        this.io = new Server(server, {path: '/router', serveClient: false, cookie: false});

        this.io.on('connection', (relaySocket: Socket) => {

            const lastRelayId = relaySocket.handshake.headers['x-last-relay-id'] as string;
            if (lastRelayId) {
                hLog(`API Stream Relay connected with ID = ${relaySocket.id} (last ID: ${lastRelayId})`);
                this.replaceRelay(relaySocket.id, lastRelayId);
            } else {
                hLog(`API Stream Relay connected with ID = ${relaySocket.id}`);
                this.relays[relaySocket.id] = {clients: 0, connected: true};
            }

            relaySocket.on('event', (data, callback) => {
                switch (data.type) {
                    case 'client_count': {
                        this.relays[relaySocket.id]['clients'] = data.counter;
                        this.countClients();
                        break;
                    }
                    case 'action_request': {
                        const result = this.addActionRequest(data, relaySocket.id);
                        if (result.status === 'OK') {
                            callback(result);
                        } else {
                            callback(result);
                        }
                        break;
                    }
                    case 'delta_request': {
                        const result = this.addDeltaRequest(data, relaySocket.id);
                        if (result.status === 'OK') {
                            callback(result);
                        } else {
                            callback(result);
                        }
                        break;
                    }
                    case 'client_disconnected': {
                        this.removeClient(data.id);
                        break;
                    }
                    case 'cancel_request': {
                        this.removeClientRequest(data.client_socket_id, data.reqUUID);
                        break;
                    }
                    default: {
                        console.log(data);
                    }
                }
            });

            relaySocket.on('disconnect', () => {
                hLog(`API Stream Relay disconnected with ID = ${relaySocket.id}`);
                this.relays[relaySocket.id].connected = false;
                this.countClients();
            });

        });

        const connOpts = this.manager.conn.chains[this.chain];

        let _port = 57200;
        if (connOpts.WS_ROUTER_PORT) {
            _port = connOpts.WS_ROUTER_PORT;
        }

        let _host = "127.0.0.1";
        if (connOpts.WS_ROUTER_HOST) {
            _host = connOpts.WS_ROUTER_HOST;
        }

        server.listen(_port, _host, () => {
            this.ready();
            setTimeout(() => {
                if (!this.firstData) {
                    this.ready();
                }
            }, 5000);
        });

    }

    ready() {
        process.send?.({event: 'router_ready'});
    }

    private removeClient(id: any) {
        const clientInfo = this.clientMap.get(id);
        if (clientInfo) {
            console.log("Removing client: ", id, clientInfo);

            const requests = clientInfo.requests;

            requests.forEach((value: TrackedRequest, requestUUID: string) => {

                console.log(requestUUID, value);

                switch (value.type) {

                    case 'action': {
                        const request = value.request as StreamActionsRequest;
                        if (request.contract && request.action && value.relay_id) {
                            // find by contract-action-relay path
                            this.contractActionRelayMap.get(request.contract)?.get(request.action)?.get(value.relay_id)?.delete(requestUUID);
                            // if there is no more requests for that contract-action-relay, delete the relay
                            if (this.contractActionRelayMap.get(request.contract)?.get(request.action)?.get(value.relay_id)?.size === 0) {
                                this.contractActionRelayMap.get(request.contract)?.get(request.action)?.delete(value.relay_id);
                            }
                            // if there is no more requests for that contract-action, delete the action
                            if (this.contractActionRelayMap.get(request.contract)?.get(request.action)?.size === 0) {
                                this.contractActionRelayMap.get(request.contract)?.delete(request.action);
                            }
                            // if there is no more requests for that contract, delete the contract entry
                            if (this.contractActionRelayMap.get(request.contract)?.size === 0) {
                                this.contractActionRelayMap.delete(request.contract);
                            }
                        } else if (!request.contract && !request.action && request.account && value.relay_id) {
                            // find by account-relay path
                            this.notifiedRelayMap.get(request.account)?.get(value.relay_id)?.delete(requestUUID);
                            // if there is no more requests for that account-relay, delete the relay
                            if (this.notifiedRelayMap.get(request.account)?.get(value.relay_id)?.size === 0) {
                                this.notifiedRelayMap.get(request.account)?.delete(value.relay_id);
                            }
                            // if there is no more requests for that account, delete the account
                            if (this.notifiedRelayMap.get(request.account)?.size === 0) {
                                this.notifiedRelayMap.delete(request.account);
                            }
                        }
                        break;
                    }

                    case 'delta': {
                        const request = value.request as StreamDeltasRequest;
                        if (request.code && request.table && value.relay_id) {
                            // find by code-table-relay path
                            this.codeTableRelayMap.get(request.code)?.get(request.table)?.get(value.relay_id)?.delete(requestUUID);
                            // if there is no more requests for that code-table-relay, delete the relay
                            if (this.codeTableRelayMap.get(request.code)?.get(request.table)?.get(value.relay_id)?.size === 0) {
                                this.codeTableRelayMap.get(request.code)?.get(request.table)?.delete(value.relay_id);
                            }
                            // if there is no more requests for that code-table, delete the table
                            if (this.codeTableRelayMap.get(request.code)?.get(request.table)?.size === 0) {
                                this.codeTableRelayMap.get(request.code)?.delete(request.table);
                            }
                            // if there is no more requests for that code, delete the code entry
                            if (this.codeTableRelayMap.get(request.code)?.size === 0) {
                                this.codeTableRelayMap.delete(request.code);
                            }
                        } else if (!request.code && !request.table && request.payer && value.relay_id) {
                            // find by payer-relay path
                            this.payerRelayMap.get(request.payer)?.get(value.relay_id)?.delete(requestUUID);
                            // if there is no more requests for that payer-relay, delete the relay
                            if (this.payerRelayMap.get(request.payer)?.get(value.relay_id)?.size === 0) {
                                this.payerRelayMap.get(request.payer)?.delete(value.relay_id);
                            }
                            // if there is no more requests for that payer, delete the payer
                            if (this.payerRelayMap.get(request.payer)?.size === 0) {
                                this.payerRelayMap.delete(request.payer);
                            }
                        }
                        break;
                    }
                }
            });

            // Delete Client
            this.clientMap.delete(id);
        }
    }

    private removeClientRequest(client_socket_id: any, reqUUID: any) {
        console.log("Removing client request: ", client_socket_id, reqUUID);
        const clientInfo = this.clientMap.get(client_socket_id);
        if (clientInfo) {
            const requests = clientInfo.requests;
            if (requests.has(reqUUID)) {

                const request = requests.get(reqUUID);
                console.log("Removing request: ", request);

                requests.delete(reqUUID);
            }
        }
    }

    private printActionClientTable() {
        // Prepare data for contract-action mappings
        const contractActionData: { contract: string; action: string; relays: number; requests: number }[] = [];

        // Collect data from contractActionRelayMap
        this.contractActionRelayMap.forEach((actionMap, contract) => {
            actionMap.forEach((relayMap, action) => {
                // Count total requests across all relays for this contract-action pair
                let totalRequests = 0;
                relayMap.forEach(requestSet => {
                    totalRequests += requestSet.size;
                });
                contractActionData.push({contract, action, relays: relayMap.size, requests: totalRequests});
            });
        });

        // Prepare data for notified mappings
        const notifiedData: { account: string; relays: number; requests: number }[] = [];

        // Collect data from notifiedRelayMap
        this.notifiedRelayMap.forEach((relayMap, account) => {
            // Count total requests across all relays for this account
            let totalRequests = 0;
            relayMap.forEach(requestSet => {
                totalRequests += requestSet.size;
            });
            notifiedData.push({account, relays: relayMap.size, requests: totalRequests});
        });

        // Display tables
        console.log("\n===== CONTRACT-ACTION REQUEST MAPPING =====");
        if (contractActionData.length > 0) {
            console.table(contractActionData);
        } else {
            console.log("No active contract-action mappings");
        }

        console.log("\n===== NOTIFIED ACCOUNT REQUEST MAPPING =====");
        if (notifiedData.length > 0) {
            console.table(notifiedData);
        } else {
            console.log("No active notified account mappings");
        }

        // Display summary
        const totalContractActionRequests = contractActionData.reduce((sum, item) => sum + item.requests, 0);
        const totalNotifiedRequests = notifiedData.reduce((sum, item) => sum + item.requests, 0);
        console.log(`\n===== SUMMARY =====`);
        console.log(`Total Contract-Action Requests: ${totalContractActionRequests}`);
        console.log(`Total Notified Account Requests: ${totalNotifiedRequests}`);
        console.log(`Total Client Tracking Entries: ${this.clientMap.size}`);
        console.log("=========================");
    }

    private printDeltaClientTable() {
        // Prepare data for code-table mappings
        const codeTableData: { code: string; table: string; relays: number; requests: number }[] = [];

        // Collect data from codeTableRelayMap
        this.codeTableRelayMap.forEach((tableMap, code) => {
            tableMap.forEach((relayMap, table) => {
                // Count total requests across all relays for this code-table pair
                let totalRequests = 0;
                relayMap.forEach(requestSet => {
                    totalRequests += requestSet.size;
                });
                codeTableData.push({code, table, relays: relayMap.size, requests: totalRequests});
            });
        });

        // Prepare data for payer mappings
        const payerData: { payer: string; relays: number; requests: number }[] = [];

        // Collect data from payerRelayMap
        this.payerRelayMap.forEach((relayMap, payer) => {
            // Count total requests across all relays for this payer
            let totalRequests = 0;
            relayMap.forEach(requestSet => {
                totalRequests += requestSet.size;
            });
            payerData.push({payer, relays: relayMap.size, requests: totalRequests});
        });

        // Display tables
        console.log("\n===== CODE-TABLE REQUEST MAPPING =====");
        if (codeTableData.length > 0) {
            console.table(codeTableData);
        } else {
            console.log("No active code-table mappings");
        }

        console.log("\n===== PAYER REQUEST MAPPING =====");
        if (payerData.length > 0) {
            console.table(payerData);
        } else {
            console.log("No active payer mappings");
        }

        // Display summary
        const totalCodeTableRequests = codeTableData.reduce((sum, item) => sum + item.requests, 0);
        const totalPayerRequests = payerData.reduce((sum, item) => sum + item.requests, 0);
        console.log(`\n===== SUMMARY =====`);
        console.log(`Total Code-Table Requests: ${totalCodeTableRequests}`);
        console.log(`Total Payer Requests: ${totalPayerRequests}`);
        console.log(`Total Client Tracking Entries: ${this.clientMap.size}`);
        console.log("=========================");
    }

    private replaceRelay(newId: string, lastRelayId: string) {
        this.relays[newId] = this.relays[lastRelayId];
        this.countClients();

        // DELTA PAYERS
        this.payerRelayMap.forEach((relayMap) => {
            const relayData = relayMap.get(lastRelayId);
            if (relayData) {
                relayMap.set(newId, relayData);
                relayData.delete(lastRelayId);
            }
        });

        // ACTION NOTIFIED
        this.notifiedRelayMap.forEach((relayMap) => {
            const relayData = relayMap.get(lastRelayId);
            if (relayData) {
                relayMap.set(newId, relayData);
                relayData.delete(lastRelayId);
            }
        });

        // ACTION CONTRACT/ACTIONS
        this.contractActionRelayMap.forEach((actionMap) => {
            actionMap.forEach((relayMap) => {
                const relayData = relayMap.get(lastRelayId);
                if (relayData) {
                    relayMap.set(newId, relayData);
                    relayData.delete(lastRelayId);
                }
            });
        });

        // DELTA CODE/TABLES
        this.codeTableRelayMap.forEach((tableMap) => {
            tableMap.forEach((relayMap) => {
                const relayData = relayMap.get(lastRelayId);
                if (relayData) {
                    relayMap.set(newId, relayData);
                    relayData.delete(lastRelayId);
                }
            });
        });
    }

    private removeRelayLinks(relay_id: string) {
        let removalCount = 0;

        // DELTA PAYERS
        this.payerRelayMap.forEach((relayMap) => {
            if (relayMap.delete(relay_id)) {
                removalCount++;
            }
        });

        // ACTION NOTIFIED
        this.notifiedRelayMap.forEach((relayMap) => {
            if (relayMap.delete(relay_id)) {
                removalCount++;
            }
        });

        // DELTA CODE/TABLES
        this.codeTableRelayMap.forEach((tableMap) => {
            tableMap.forEach((relayMap) => {
                if (relayMap.delete(relay_id)) {
                    removalCount++;
                }
            });
        });

        // ACTION CONTRACT/ACTIONS
        this.contractActionRelayMap.forEach((actionMap) => {
            actionMap.forEach((relayMap) => {
                if (relayMap.delete(relay_id)) {
                    removalCount++;
                }
            });
        });

        hLog(`Removed ${removalCount} relay links for relay ${relay_id}`);
        // this.printDeltaClientTable();
    }
}
