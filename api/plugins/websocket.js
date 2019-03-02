const fp = require('fastify-plugin');
const WebSocket = require('ws');

module.exports = fp((fastify, opts, next) => {

    const wss = new WebSocket.Server({
        server: fastify.server
    });

    const ws = new WebSocket('ws://127.0.0.1:7001', [], {
        perMessageDeflate: false
    });

    ws.on('open', function open() {
        console.log('router connected');
    });

    fastify.decorate('wss', wss);
    fastify.decorate('ws', ws);

    fastify.addHook('onClose', (fastify, done) => {
        fastify.ws.close(done);
        fastify.wss.close(done);
    });

    next();
}, {
    fastify: '2.x',
    name: 'fastify-websocket'
});
