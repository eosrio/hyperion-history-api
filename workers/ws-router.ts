import {HyperionWorker} from "./hyperionWorker";

import * as IOServer from 'socket.io';
import {checkFilter, hLog} from "../helpers/common_functions";

const greylist = ['eosio.token'];

export default class WSRouter extends HyperionWorker {

    q: string;
    totalRoutedMessages = 0;
    firstData = false;
    relays = {};
    clientIndex = new Map();
    codeActionMap = new Map();
    notifiedMap = new Map();
    codeDeltaMap = new Map();
    payerMap = new Map();
    activeRequests = new Map();
    private io: IOServer.Server;
    private totalClients = 0;

    constructor() {
        super();
        this.q = this.chain + ':stream';
        this.activeRequests.set('*', {
            sockets: []
        });
    }

    assertQueues(): void {
        this.ch.assertQueue(this.q);
        this.ch.consume(this.q, this.onConsume.bind(this));
    }


    onIpcMessage(msg: any): void {
        hLog(msg.event);
    }

    async run(): Promise<void> {
        this.initRoutingServer();
        this.startRoutingRateMonitor();
        return undefined;
    }

    onConsume(msg) {
        if (!this.firstData) {
            this.firstData = true;
        }
        switch (msg.properties.headers.event) {
            case 'trace': {
                const actHeader = msg.properties.headers;
                const code = actHeader.account;
                const name = actHeader.name;
                const notified = actHeader.notified.split(',');
                // console.log(`ACTION: ${code}::${name} - [${actHeader.notified}]`);
                let decodedMsg;
                if (this.codeActionMap.has(code)) {
                    const codeReq = this.codeActionMap.get(code);
                    decodedMsg = Buffer.from(msg.content).toString();
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

            case 'delta': {
                const deltaHeader = msg.properties.headers;
                const code = deltaHeader.code;
                const table = deltaHeader.table;
                // const scope = deltaHeader.scope;
                const payer = deltaHeader.payer;
                // console.log(code, table, scope, payer);
                let decodedDeltaMsg;
                // Forward to CODE/TABLE listeners
                if (this.codeDeltaMap.has(code)) {
                    decodedDeltaMsg = Buffer.from(msg.content).toString();

                    const tableDeltaMap = this.codeDeltaMap.get(code);
                    // Send specific table
                    if (tableDeltaMap.has(table)) {
                        for (const link of tableDeltaMap.get(table).links) {
                            this.forwardDeltaMessage(decodedDeltaMsg, link, payer);
                        }
                    }
                    // Send any table
                    if (tableDeltaMap.has("*")) {
                        for (const link of tableDeltaMap.get("*").links) {
                            this.forwardDeltaMessage(decodedDeltaMsg, link, payer);
                        }
                    }
                }
                // Forward to PAYER listeners
                if (this.payerMap.has(payer)) {
                    decodedDeltaMsg = Buffer.from(msg.content).toString();
                    for (const link of this.payerMap.get(payer).links) {
                        this.forwardDeltaMessage(decodedDeltaMsg, link, payer);
                    }
                }
                break;
            }

            default: {
                console.log('Unindentified message!');
                console.log(msg);
            }
        }
        this.ch.ack(msg);
    }

    startRoutingRateMonitor() {
        setInterval(() => {
            console.log('[Router] Routing rate: ' + (this.totalRoutedMessages / 20) + ' msg/s');
            this.totalRoutedMessages = 0;
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
        console.log('Total WS clients:', this.totalClients);
    }

    appendToL1Map(target, primary, link) {
        if (target.has(primary)) {
            target.get(primary).links.push(link);
        } else {
            target.set(primary, {links: [link]});
        }
    }

    appendToL2Map(target, primary, secondary, link) {
        if (target.has(primary)) {
            const pMap = target.get(primary);
            if (pMap.has(secondary)) {
                const pLinks = pMap.get(secondary);
                pLinks.links.push(link);
            } else {
                pMap.set(secondary, {
                    links: [link]
                });
            }
        } else {
            const sMap = new Map();
            sMap.set(secondary, {
                links: [link]
            });
            target.set(primary, sMap);
        }
    }

    addActionRequest(data, id) {
        const req = data.request;
        if (greylist.indexOf(req.contract) !== -1) {
            if (req.notified === '' || req.notified === req.contract) {
                return {
                    status: 'FAIL',
                    reason: 'request too broad, please be more specific'
                };
            }
        }
        const link = {
            type: 'action',
            relay: id,
            client: data.client_socket,
            filters: req.filters,
            account: req.account,
            added_on: Date.now()
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
        this.addToClientIndex(data, id, [req.contract, req.action, req.account]);
        return {
            status: 'OK'
        };
    }

    addToClientIndex(data, id, path) {
        // register client on index
        if (this.clientIndex.has(data.client_socket)) {
            this.clientIndex.get(data.client_socket).set(id, path);
            console.log('new relay added to existing client');
        } else {
            const list = new Map();
            list.set(id, path);
            this.clientIndex.set(data.client_socket, list);
            console.log('new client added to index');
        }
    }

    addDeltaRequest(data, id) {
        const req = data.request;
        const link = {
            type: 'delta',
            relay: id,
            client: data.client_socket,
            filters: data.request.filters,
            payer: data.request.payer,
            added_on: Date.now()
        };
        if (req.code !== '' && req.code !== '*') {
            this.appendToL2Map(this.codeDeltaMap, req.code, req.table, link);
        } else {
            if (req.payer !== '' && req.payer !== '*') {
                this.appendToL1Map(this.payerMap, req.payer, link);
            } else {
                return {status: 'FAIL', reason: 'invalid request'};
            }
        }
        this.addToClientIndex(data, id, [req.code, req.table, req.payer]);
        return {
            status: 'OK'
        };
    }

    removeDeepLinks(map, path, key, id) {
        if (map.has(path[0])) {
            if (map.get(path[0]).has(path[1])) {
                const currentLinks = map.get(path[0]).get(path[1]).links;
                currentLinks.forEach((item, index) => {
                    if (item.relay === key && item.client === id) {
                        currentLinks.splice(index, 1);
                    }
                });
            }
        }
    }

    removeSingleLevelLinks(map, path, key, id) {
        if (map.has(path[2])) {
            const _links = map.get(path[2]).links;
            _links.forEach((item, index) => {
                if (item.relay === key && item.client === id) {
                    _links.splice(index, 1);
                }
            });
        }
    }

    removeLinks(id) {
        console.log(`Removing links for ${id}...`);
        if (this.clientIndex.has(id)) {
            const links = this.clientIndex.get(id);
            links.forEach((path, key) => {
                this.removeDeepLinks(this.codeActionMap, path, key, id);
                this.removeDeepLinks(this.codeDeltaMap, path, key, id);
                this.removeSingleLevelLinks(this.notifiedMap, path, key, id);
                this.removeSingleLevelLinks(this.payerMap, path, key, id);
            });
        }
    }

    initRoutingServer() {
        const server = require('http').createServer();
        this.io = IOServer(server, {
            path: '/router',
            serveClient: false,
            cookie: false
        });

        this.io.on('connection', (socket) => {
            console.log(`[ROUTER] New relay connected with ID = ${socket.id}`);
            this.relays[socket.id] = {clients: 0, connected: true};
            socket.on('event', (data, callback) => {
                switch (data.type) {
                    case 'client_count': {
                        this.relays[socket.id]['clients'] = data.counter;
                        this.countClients();
                        break;
                    }
                    case 'action_request': {
                        const result = this.addActionRequest(data, socket.id);
                        if (result.status === 'OK') {
                            callback(result);
                        } else {
                            callback(result.reason);
                        }
                        break;
                    }
                    case 'delta_request': {
                        const result = this.addDeltaRequest(data, socket.id);
                        if (result.status === 'OK') {
                            callback(result);
                        } else {
                            callback(result.reason);
                        }
                        break;
                    }
                    case 'client_disconnected': {
                        this.removeLinks(data.id);
                        break;
                    }
                    default: {
                        console.log(data);
                    }
                }
            });
            socket.on('disconnect', () => {
                this.relays[socket.id].connected = false;
                this.countClients();
            });
        });

        server.listen(this.manager.conn.chains[this.chain].WS_ROUTER_PORT, () => {
            this.ready();
            setTimeout(() => {
                if (!this.firstData) {
                    this.ready();
                }
            }, 5000);
        });

    }

    ready() {
        process.send({event: 'router_ready'});
    }

    private forwardActionMessage(msg: any, link: any, notified: string[]) {
        let allow = false;
        if (this.io.sockets.connected[link.relay]) {
            if (link.notified !== '') {
                allow = notified.indexOf(link.account) !== -1;
            } else {
                allow = true;
            }
            if (link.filters.length > 0) {
                // check filters
                const _parsedMsg = JSON.parse(msg);
                allow = link.filters.every(filter => {
                    return checkFilter(filter, _parsedMsg);
                });
            }
            if (allow) {
                this.io.sockets.connected[link.relay].emit('trace', {
                    client: link.client,
                    message: msg
                });
                this.totalRoutedMessages++;
            }
        }
    }

    private forwardDeltaMessage(msg, link, payer) {
        let allow = false;
        if (this.io.sockets.connected[link.relay]) {
            if (link.payer !== '') {
                allow = link.payer === payer;
            } else {
                allow = true;
            }
            // if (link.filters.length > 0) {
            //     // check filters
            //     const _parsedMsg = JSON.parse(msg);
            //     allow = link.filters.every(filter => {
            //         return checkDeltaFilter(filter, _parsedMsg);
            //     });
            // }
            if (allow) {
                this.io.sockets.connected[link.relay].emit('delta', {
                    client: link.client,
                    message: msg
                });
                this.totalRoutedMessages++;
            }
        }
    }
}
