const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();
const IOServer = require('socket.io');
const {checkFilter} = require("../helpers/functions");
let io;
let channel;

const config = require(`../${process.env.CONFIG_JSON}`);

const WS_PORT = require('../connections').chains[config.settings.chain]['WS_ROUTER_PORT'];

const activeRequests = new Map();

activeRequests.set('*', {
    sockets: []
});

let firstData = false;

const relays = {};
const clientIndex = new Map();

// ACTIONS
const codeActionMap = new Map();
const notifiedMap = new Map();

// DELTAS
const codeDeltaMap = new Map();
const payerMap = new Map();

function forwardActionMessage(msg, link, notified) {
    let allow = false;
    if (io.sockets.connected[link.relay]) {
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
            io.sockets.connected[link.relay].emit('trace', {
                client: link.client,
                message: msg
            });
            totalRoutedMessages++;
        }
    }
}

// function checkDeltaFilter(filter, _parsedMsg) {
//     return undefined;
// }

function forwardDeltaMessage(msg, link, payer) {
    let allow = false;
    if (io.sockets.connected[link.relay]) {
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
            io.sockets.connected[link.relay].emit('delta', {
                client: link.client,
                message: msg
            });
            totalRoutedMessages++;
        }
    }
}

function onConsume(msg) {
    if (!firstData) {
        firstData = true;
    }
    switch (msg.properties.headers.event) {
        case 'trace': {
            const actHeader = msg.properties.headers;
            const code = actHeader.account;
            const name = actHeader.name;
            const notified = actHeader.notified.split(',');
            // console.log(`ACTION: ${code}::${name} - [${actHeader.notified}]`);
            let decodedMsg;
            if (codeActionMap.has(code)) {
                const codeReq = codeActionMap.get(code);
                decodedMsg = Buffer.from(msg.content).toString();
                if (codeReq.has(name)) {
                    for (const link of codeReq.get(name).links) {
                        forwardActionMessage(decodedMsg, link, notified);
                    }
                }
                // send to wildcard subscribers
                if (codeReq.has("*")) {
                    for (const link of codeReq.get("*").links) {
                        forwardActionMessage(decodedMsg, link, notified);
                    }
                }
            }

            notified.forEach((acct) => {
                if (notifiedMap.has(acct)) {
                    if (!decodedMsg) {
                        decodedMsg = Buffer.from(msg.content).toString();
                    }
                    for (const link of notifiedMap.get(acct).links) {
                        forwardActionMessage(decodedMsg, link, notified);
                    }
                }
            });
            break;
        }

        case 'delta': {
            const deltaHeader = msg.properties.headers;
            const code = deltaHeader.code;
            const table = deltaHeader.table;
            const scope = deltaHeader.scope;
            const payer = deltaHeader.payer;
            // console.log(code, table, scope, payer);
            let decodedDeltaMsg;
            // Forward to CODE/TABLE listeners
            if (codeDeltaMap.has(code)) {
                decodedDeltaMsg = Buffer.from(msg.content).toString();

                const tableDeltaMap = codeDeltaMap.get(code);
                // Send specific table
                if (tableDeltaMap.has(table)) {
                    for (const link of tableDeltaMap.get(table).links) {
                        forwardDeltaMessage(decodedDeltaMsg, link, payer, scope);
                    }
                }
                // Send any table
                if (tableDeltaMap.has("*")) {
                    for (const link of tableDeltaMap.get("*").links) {
                        forwardDeltaMessage(decodedDeltaMsg, link, payer, scope);
                    }
                }
            }
            // Forward to PAYER listeners
            if (payerMap.has(payer)) {
                decodedDeltaMsg = Buffer.from(msg.content).toString();
                for (const link of payerMap.get(payer).links) {
                    forwardDeltaMessage(decodedDeltaMsg, link, payer, scope);
                }
            }
            break;
        }

        default: {
            console.log('Unindentified message!');
            console.log(msg);
        }
    }
    channel.ack(msg);
}

function ready() {
    process.send({
        event: 'router_ready'
    });
}

let totalClients = 0;

function countClients() {
    let total = 0;
    for (let key in relays) {
        if (relays.hasOwnProperty(key)) {
            if (relays[key].connected) {
                total += relays[key].clients;
            }
        }
    }
    totalClients = total;
    console.log('Total WS clients:', totalClients);
}

function addToClientIndex(data, id, path) {
    // register client on index
    if (clientIndex.has(data.client_socket)) {
        clientIndex.get(data.client_socket).set(id, path);
        console.log('new relay added to existing client');
    } else {
        const list = new Map();
        list.set(id, path);
        clientIndex.set(data.client_socket, list);
        console.log('new client added to index');
    }
}

const greylist = ['eosio.token'];

function appendToL2Map(target, primary, secondary, link) {
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

function appendToL1Map(target, primary, link) {
    if (target.has(primary)) {
        target.get(primary).links.push(link);
    } else {
        target.set(primary, {links: [link]});
    }
}

function addDeltaRequest(data, id) {
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
        appendToL2Map(codeDeltaMap, req.code, req.table, link);
    } else {
        if (req.payer !== '' && req.payer !== '*') {
            appendToL1Map(payerMap, req.payer, link);
        } else {
            return {status: 'FAIL', reason: 'invalid request'};
        }
    }
    addToClientIndex(data, id, [req.code, req.table, req.payer]);
    return {
        status: 'OK'
    };
}

function addActionRequest(data, id) {
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
        appendToL2Map(codeActionMap, req.contract, req.action, link);
    } else {
        if (req.account !== '') {
            appendToL1Map(notifiedMap, req.account, link);
        } else {
            return {status: 'FAIL', reason: 'invalid request'};
        }
    }
    addToClientIndex(data, id, [req.contract, req.action, req.account]);
    return {
        status: 'OK'
    };
}

function removedDeepLinks(map, path, key, id) {
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

function removeSingleLevelLinks(map, path, key, id) {
    if (map.has(path[2])) {
        const _links = map.get(path[2]).links;
        _links.forEach((item, index) => {
            if (item.relay === key && item.client === id) {
                _links.splice(index, 1);
            }
        });
    }
}

function removeLinks(id) {
    console.log(`Removing links for ${id}...`);
    if (clientIndex.has(id)) {
        const links = clientIndex.get(id);
        links.forEach((path, key) => {
            removedDeepLinks(codeActionMap, path, key, id);
            removedDeepLinks(codeDeltaMap, path, key, id);
            removeSingleLevelLinks(notifiedMap, path, key, id);
            removeSingleLevelLinks(payerMap, path, key, id);
        });
    }
}

function initRoutingServer() {
    const server = require('http').createServer();
    io = IOServer(server, {
        path: '/router',
        serveClient: false,
        cookie: false
    });
    io.on('connection', (socket) => {
        console.log(`[ROUTER] New relay connected with ID = ${socket.id}`);
        relays[socket.id] = {clients: 0, connected: true};
        socket.on('event', (data, callback) => {
            switch (data.type) {
                case 'client_count': {
                    relays[socket.id]['clients'] = data.counter;
                    countClients();
                    break;
                }
                case 'action_request': {
                    const result = addActionRequest(data, socket.id);
                    if (result.status === 'OK') {
                        callback(result);
                    } else {
                        callback(result.reason);
                    }
                    break;
                }
                case 'delta_request': {
                    const result = addDeltaRequest(data, socket.id);
                    if (result.status === 'OK') {
                        callback(result);
                    } else {
                        callback(result.reason);
                    }
                    break;
                }
                case 'client_disconnected': {
                    removeLinks(data.id);
                    break;
                }
                default: {
                    console.log(data);
                }
            }
        });
        socket.on('disconnect', () => {
            relays[socket.id].connected = false;
            countClients();
        });
    });

    server.listen(WS_PORT, () => {
        ready();
        setTimeout(() => {
            if (!firstData) {
                ready();
            }
        }, 5000);
    });

}

const queue_prefix = config.settings.chain;
const q = queue_prefix + ':stream';

let totalRoutedMessages = 0;

function startRoutingRateMonitor() {
    setInterval(() => {
        console.log('[Router] Routing rate: ' + (totalRoutedMessages / 20) + ' msg/s');
        totalRoutedMessages = 0;
    }, 20000);
}

async function run() {

    console.log('stream router loaded');

    [channel,] = await manager.createAMQPChannels((channels) => {
        [channel,] = channels;
        channel.assertQueue(q);
        channel.consume(q, onConsume);
    });
    channel.assertQueue(q);
    channel.consume(q, onConsume);

    initRoutingServer();
    startRoutingRateMonitor();
}

module.exports = {run};
