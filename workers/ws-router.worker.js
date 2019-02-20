const WebSocket = require('ws');
const {amqpConnect} = require("../connections/rabbitmq");

let wss;
let channel;
const port = 7001;
const addr = '127.0.0.1';

function onConsume(msg) {
    const act = msg.properties.headers;
    if (`${act['account']}:${act['name']}` === 'eosbetdice11:betreceipt') {
        console.log(JSON.parse(Buffer.from(msg.content).toString()).act.data);
    }
    channel.ack(msg);
}

async function run() {
    [channel,] = await amqpConnect();
    const queue_prefix = process.env.CHAIN;
    const q = queue_prefix + ':stream';
    channel.assertQueue(q);
    // channel.prefetch(20);
    channel.consume(q, onConsume);

    wss = new WebSocket.Server({
        host: addr,
        port: port
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
        });
    });
}

module.exports = {run};
