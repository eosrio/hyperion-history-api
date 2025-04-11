import {Server, Socket} from "socket.io";
import {createServer} from "http";
import {HyperionWorker} from "./hyperionWorker.js";
import {checkDeltaFilter, checkFilter, hLog} from "../helpers/common_functions.js";
import {RabbitQueueDef} from "../definitions/index-queues.js";
import {ActionLink, DeltaLink} from "../../interfaces/stream-links.js";
import {
    RequestFilter,
    StreamActionsRequest,
    StreamDeltasRequest,
    StreamMessage
} from "../../interfaces/stream-requests.js";
import {ConsumeMessage} from "amqplib";

const greylist = ['eosio.token'];

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
    relays = {};
    clientIndex: Map<string, Map<string, Map<string, string[]>>> = new Map();
    codeActionMap = new Map();
    notifiedMap = new Map();
    codeDeltaMap = new Map();
    payerMap = new Map();
    activeRequests = new Map();
    private io?: Server;
    private totalClients = 0;

    // reverse index for clients
    private clientMap: Map<string, ClientInfo> = new Map();

    // code >> table >> relayId >> requestIds
    private codeTableRelayMap: Map<string, Map<string, Map<string, Set<string>>>> = new Map();

    // payer >> relayId >> requestIds
    private payerRelayMap: Map<string, Map<string, Set<string>>> = new Map();

    // map to fetch the set of destination relays for a code-action pair
    private codeActionRelayMap: Map<string, Map<string, Set<string>>> = new Map();

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

    appendIdAndEmit(event, data) {
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
                    const actHeader = msg.properties.headers;
                    const code = actHeader.account;
                    const name = actHeader.name;
                    const notified = actHeader.notified.split(',');
                    let decodedMsg;

                    // send to contract subscribers
                    if (this.codeActionMap.has(code)) {
                        const codeReq = this.codeActionMap.get(code);
                        decodedMsg = Buffer.from(msg.content).toString();

                        // send to action subscribers
                        if (codeReq.has(name)) {
                            for (const link of codeReq.get(name).links) {
                                this.forwardActionMessage(decodedMsg, link, notified);
                            }
                        }
                        // send to wildcard subscribers
                        if (codeReq.has("*")) {
                            for (const link of codeReq.get("*").links) {
                                this.forwardActionMessage(decodedMsg, link, notified);
                            }
                        }
                    }

                    // send to notification subscribers
                    notified.forEach((acct) => {
                        if (this.notifiedMap.has(acct)) {
                            if (!decodedMsg) {
                                decodedMsg = Buffer.from(msg.content).toString();
                            }
                            for (const link of this.notifiedMap.get(acct).links) {
                                this.forwardActionMessage(decodedMsg, link, notified);
                            }
                        }
                    });
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
        for (const relay_id of targetRelays.values()) {
            this.io?.of('/').sockets.get(relay_id)?.emit('delta', {
                ...msg.properties.headers,
                message: Buffer.from(msg.content).toString()
            });
        }
    }

    startRoutingRateMonitor() {
        setInterval(() => {
            if (this.totalRoutedMessages > 0) {
                hLog('[Router] Routing rate: ' + (this.totalRoutedMessages / 20) + ' msg/s');
                this.totalRoutedMessages = 0;
            }
        }, 20000);
    }

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

    appendToL1Map(target, primary, link: ActionLink | DeltaLink) {
        if (target.has(primary)) {
            target.get(primary).links.push(link);
        } else {
            target.set(primary, {links: [link]});
        }
    }

    appendToL2Map(target, primary, secondary, link: ActionLink | DeltaLink) {
        if (target.has(primary)) {
            const pMap = target.get(primary);
            if (pMap.has(secondary)) {
                const pLinks = pMap.get(secondary);
                pLinks.links.push(link);
            } else {
                pMap.set(secondary, {links: [link]});
            }
        } else {
            const sMap = new Map();
            sMap.set(secondary, {links: [link]});
            target.set(primary, sMap);
        }
    }

    addActionRequest(data: StreamMessage<StreamActionsRequest>, relay_id: string) {
        const req = data.request;
        if (typeof req.account !== 'string') {
            return {status: 'FAIL', reason: 'invalid request'};
        }
        if (greylist.indexOf(req.contract) !== -1) {
            if (req.account === '' || req.account === req.contract) {
                return {status: 'FAIL', reason: 'request too broad, please be more specific'};
            }
        }
        const link: ActionLink = {
            type: 'action',
            relay: relay_id,
            reqUUID: data.reqUUID,
            client: data.client_socket,
            filters: req.filters,
            account: req.account,
            added_on: Date.now(),
            filter_op: req.filter_op
        };
        if (req.contract !== '' && req.contract !== '*') {
            this.appendToL2Map(this.codeActionMap, req.contract, req.action, link);
        } else {
            if (req.account !== '') {
                this.appendToL1Map(this.notifiedMap, req.account, link);
            } else {
                return {status: 'FAIL', reason: 'invalid request'};
            }
        }
        this.addToClientIndex(
            data.client_socket,
            relay_id,
            [req.contract, req.action, req.account],
            data.reqUUID
        );
        return {status: 'OK'};
    }

    addToClientIndex(client_id: string, relay_id: string, path: string[], reqUUID: string) {
        // register client on index
        if (this.clientIndex.has(client_id)) {
            const relayMap = this.clientIndex.get(client_id);
            if (relayMap && relayMap.has(relay_id)) {
                const requestMap = relayMap.get(relay_id);
                if (requestMap) {
                    requestMap.set(reqUUID, path);
                }
            }
            console.log(`new relay link added to existing client, using ${reqUUID}`);
        } else {
            const list = new Map();
            const requests = new Map();
            requests.set(reqUUID, path);
            list.set(relay_id, requests);
            this.clientIndex.set(client_id, list);
            console.log('new client added to index');
        }
    }

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

        console.log("clientMap ->> ", this.clientMap);
        console.log("codeTableRelayMap ->> ", this.codeTableRelayMap);
        console.log("payerRelayMap ->> ", this.payerRelayMap);

        // const link: DeltaLink = {
        //     type: 'delta',
        //     relay: relay_id,
        //     reqUUID: data.reqUUID,
        //     client: data.client_socket,
        //     filters: data.request.filters,
        //     payer: data.request.payer,
        //     added_on: Date.now(),
        //     filter_op: data.request.filter_op
        // };
        // console.log(`New Delta Request - client: ${data.client_socket} - relay: ${relay_id}`);
        // if (req.code !== '' && req.code !== '*') {
        //     this.appendToL2Map(this.codeDeltaMap, req.code, req.table, link);
        // } else {
        //     if (req.payer !== '' && req.payer !== '*') {
        //         this.appendToL1Map(this.payerMap, req.payer, link);
        //     } else {
        //         return {status: 'FAIL', reason: 'invalid request'};
        //     }
        // }
        // this.addToClientIndex(data.client_socket,
        //     relay_id,
        //     [req.code, req.table, req.payer],
        //     data.reqUUID
        // );
        // console.log(this.clientIndex);
        // console.log();
        //
        // this.codeDeltaMap.forEach((value, key) => {
        //     console.log(`Code: ${key}`);
        //     value.forEach((value2, key2) => {
        //         console.log(`Table: ${key2}`);
        //         console.log(value2);
        //     });
        // })

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

    removeLinks(id: string, reqUUID?: string) {
        console.log(`Removing links for ${id}... (optional request id: ${reqUUID})`);
        if (this.clientIndex.has(id)) {
            // find relay links by client ID
            const links = this.clientIndex.get(id);
            if (links) {
                links.forEach((requests: Map<string, string[]>, relay_id: string) => {
                    // remove a single stream link
                    if (reqUUID) {
                        const path = requests.get(reqUUID);
                        console.log('removing path:', path);
                        if (path) {
                            this.removeDeepLinks(this.codeActionMap, path, relay_id, id, reqUUID);
                            this.removeDeepLinks(this.codeDeltaMap, path, relay_id, id, reqUUID);
                            this.removeSingleLevelLinks(this.notifiedMap, path, relay_id, id, reqUUID);
                            this.removeSingleLevelLinks(this.payerMap, path, relay_id, id, reqUUID);
                            console.log(`Client: ${id}, Relay: ${relay_id} ->`, path);
                            requests.delete(reqUUID);
                        }
                    } else {
                        // remove all requests for the client socket
                        console.log("Removing all requests for client: ", id);
                        requests.forEach((path: string[]) => {
                            this.removeDeepLinks(this.codeActionMap, path, relay_id, id);
                            this.removeDeepLinks(this.codeDeltaMap, path, relay_id, id);
                            this.removeSingleLevelLinks(this.notifiedMap, path, relay_id, id);
                            this.removeSingleLevelLinks(this.payerMap, path, relay_id, id);
                        })
                    }
                });
            }
            console.log("codeActionMap", this.codeActionMap);
            console.log("codeDeltaMap", this.codeDeltaMap);
        }
    }


    initRoutingServer() {

        const server = createServer();

        // Internal server for ROUTER-RELAY sockets
        this.io = new Server(server, {path: '/router', serveClient: false, cookie: false});

        this.io.on('connection', (relaySocket: Socket) => {
            hLog(`API Stream Relay connected with ID = ${relaySocket.id}`);

            this.relays[relaySocket.id] = {clients: 0, connected: true};

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
                        this.printClientTable();
                        const result = this.addDeltaRequest(data, relaySocket.id);
                        if (result.status === 'OK') {
                            callback(result);
                        } else {
                            callback(result);
                        }
                        break;
                    }
                    case 'client_disconnected': {
                        // this.removeLinks(data.id);
                        this.removeClient(data.id);
                        this.printClientTable();
                        // callback({status: "OK"});
                        break;
                    }
                    case 'cancel_request': {
                        this.removeClientRequest(data.client_socket_id, data.reqUUID);
                        // this.removeLinks(data.client_socket_id, data.reqUUID);
                        // callback({status: "OK"});
                        break;
                    }
                    default: {
                        console.log(data);
                    }
                }
            });
            relaySocket.on('disconnect', () => {
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

    private forwardActionMessage(msg: any, link: ActionLink, notified: string[]) {

        if (!this.io) {
            hLog("Websocket server was not started!");
            return;
        }

        let allow = false;
        const relay = this.io.of('/').sockets.get(link.relay);
        if (relay) {

            if (link.account !== '') {
                allow = notified.indexOf(link.account) !== -1;
            } else {
                allow = true;
            }

            if (link.filters && link.filters?.length > 0) {
                // check filters
                const _parsedMsg = JSON.parse(msg);

                if (link.filter_op === 'or') {
                    allow = link.filters.some((filter: RequestFilter) => {
                        return checkFilter(filter, _parsedMsg);
                    });
                } else {
                    allow = link.filters.every((filter: RequestFilter) => {
                        return checkFilter(filter, _parsedMsg);
                    });
                }
            }

            if (allow) {
                relay.emit('trace', {client: link.client, req: link.reqUUID, message: msg});
                this.totalRoutedMessages++;
            }
        }
    }


    private forwardDeltaMessage(msg: string, link: DeltaLink, payer: string) {
        if (!this.io) {
            hLog("Websocket server was not started!");
            return;
        }

        let allow = false;
        const relay = this.io.of('/').sockets.get(link.relay);
        if (relay) {

            if (link.payer) {
                allow = link.payer === payer;
            } else {
                allow = true;
            }

            if (link.filters && link.filters?.length > 0) {
                // check filters
                const _parsedMsg = JSON.parse(msg);
                if (link.filter_op === 'or') {
                    allow = link.filters.some((filter: RequestFilter) => {
                        return checkDeltaFilter(filter, _parsedMsg);
                    });
                } else {
                    allow = link.filters.every((filter: RequestFilter) => {
                        return checkDeltaFilter(filter, _parsedMsg);
                    });
                }
            }

            if (allow) {
                relay.emit('delta', {client: link.client, req: link.reqUUID, message: msg});
                this.totalRoutedMessages++;
            }
        }
    }

    private removeClient(id: any) {
        const clientInfo = this.clientMap.get(id);
        if (clientInfo) {
            console.log("Removing client: ", id, clientInfo);
            const requests = clientInfo.requests;
            requests.forEach((value: TrackedRequest, requestUUID: string) => {
                console.log(requestUUID, value);
                switch (value.type) {
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
                            this.payerRelayMap.get(request.payer)?.get(value.relay_id)?.delete(requestUUID)
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
                    case 'action': {
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


    private printClientTable() {
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

                codeTableData.push({
                    code,
                    table,
                    relays: relayMap.size,
                    requests: totalRequests
                });
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

            payerData.push({
                payer,
                relays: relayMap.size,
                requests: totalRequests
            });
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
    }
}
