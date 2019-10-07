const Redis = require('ioredis');
const openApi = require('./config/openApi');
const AutoLoad = require('fastify-autoload');
const path = require('path');

process.title = `hyp-${process.env.CHAIN}-api`;

const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

const fastify = require('fastify')({
    ignoreTrailingSlash: true,
    trustProxy: true
});

fastify.register(require('fastify-elasticsearch'), {
    client: manager.elasticsearchClient
});

fastify.register(require('fastify-redis'), manager.redisOptions);

fastify.register(require('./plugins/eosjs'));

fastify.register(require('fastify-rate-limit'), {
    max: 5000,
    whitelist: [],
    timeWindow: '1 minute',
    redis: new Redis(manager.redisOptions.port, manager.redisOptions.host)
});

fastify.register(require('fastify-oas'), openApi.options);

fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'handlers', 'v1-history'),
    options: {
        prefix: '/v1/history'
    }
});

fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'handlers', 'v1-chain'),
    options: {
        prefix: '/v1/chain'
    }
});

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

fastify.register(require('./handlers/health'), {prefix: '/v2'});

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
        await fastify.listen({
            port: process.env.SERVER_PORT,
            host: process.env.SERVER_ADDR
        });
        fastify.log.info(`server listening on ${fastify.server.address().port}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1)
    }
})();
