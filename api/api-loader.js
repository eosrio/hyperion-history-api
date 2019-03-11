const Redis = require('ioredis');
const openApi = require('./config/openApi');
const AutoLoad = require('fastify-autoload');
const path = require('path');

const fastify = require('fastify')({
    ignoreTrailingSlash: true,
    trustProxy: true
});

fastify.register(require('fastify-elasticsearch'), {
    host: process.env.ES_HOST
});

fastify.register(require('fastify-redis'), {host: '127.0.0.1'});

fastify.register(require('fastify-rate-limit'), {
    max: 1000,
    whitelist: ["35.230.63.54"],
    timeWindow: '1 minute',
    redis: new Redis()
});

fastify.register(require('fastify-oas'), openApi.options);

fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'handlers', 'history'),
    options: {
        prefix: '/v2/history'
    }
});

fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'handlers', 'state'),
    options: {
        prefix: '/v2/state'
    }
});

fastify.register(require('fastify-cors'));

fastify.ready().then(async () => {
    console.log(process.env.CHAIN + ' api successfully booted!');
    await fastify.oas();

    // fastify.wss.on('connection', (socket) => {
    //     console.log('Client Connected');
    //
    //     socket.send(JSON.stringify({
    //         event: 'welcome',
    //         msg: 'waiting for command'
    //     }));
    //
    //     socket.on('message', (data) => {
    //         console.log(data);
    //         const message = JSON.parse(data);
    //         if (message.event === 'stream_actions') {
    //             fastify.ws.send(JSON.stringify({
    //                 event: 'stream_request',
    //                 id: '1',
    //                 data: message.request
    //             }));
    //
    //             fastify.ws.on('message', (data) => {
    //                 console.log(data);
    //             });
    //         }
    //     });
    //
    //     socket.on('close', () => {
    //
    //         // Kill streaming channel
    //         fastify.ws.send(JSON.stringify({
    //             event: 'disconnect_streamer',
    //             id: '1'
    //         }));
    //         console.log('Client disconnected.')
    //     })
    // });

}, (err) => {
    console.log('an error happened', err)
});

(async () => {
    try {
        await fastify.listen(process.env.SERVER_PORT, process.env.SERVER_ADDR);
        fastify.log.info(`server listening on ${fastify.server.address().port}`)
    } catch (err) {
        fastify.log.error(err);
        process.exit(1)
    }
})();
