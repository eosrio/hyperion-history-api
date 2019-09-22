const WebSocket = require('ws');
const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

let wss;
let channel;
const port = 7001;
const addr = '127.0.0.1';

const activeRequests = new Map();
const expirationTimes = [];

activeRequests.set('*', {
    sockets: []
});

function onConsume(msg) {
    const act = msg.properties.headers;
    const code = act.account;
    const name = act.name;
    // console.log(code, '->', name);
    if (activeRequests.has(code)) {
        const codeReq = activeRequests.get(code);
        if (codeReq.has(name)) {
            const sockets = codeReq.get(name).sockets;
            if (sockets.length > 0) {
                console.log('Request for', code, name);
                for (const socket of sockets) {
                    socket.send(msg.content);
                }
            }
        }
    }
    channel.ack(msg);
}

async function run() {

    [channel,] = await manager.createAMQPChannels((channels) => {
        [channel,] = channels;
    });

    const queue_prefix = process.env.CHAIN;
    const q = queue_prefix + ':stream';
    channel.assertQueue(q);
    channel.consume(q, onConsume);
    wss = new WebSocket.Server({
        host: addr,
        port: port,
        perMessageDeflate: false
    }, (conn) => {
        console.log(conn);
    });
    wss.on('listening', () => {
        console.log(`WebSocket server listening on ws://${addr}:${port}`);
        process.send({
            event: 'router_ready'
        });
    });
    wss.on('connection', (socket) => {
        console.log('new connection!');
        socket.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.event === 'stream_request') {
                const name = message.data.name;
                const code = message.data.code;
                if (activeRequests.has(code)) {
                    if (activeRequests.get(code).has(name)) {
                        activeRequests.get(code).get(name).sockets.push(socket);
                    } else {
                        activeRequests.get(code).set(name, {
                            sockets: [socket]
                        })
                    }
                } else {
                    const methodMap = new Map();
                    methodMap.set(name, {
                        sockets: [socket]
                    });
                    activeRequests.set(code, methodMap);
                }

                expirationTimes.push({
                    code: code,
                    name: name,
                    ts: Date.now()
                });
            }
        });
    });
}

module.exports = {run};
