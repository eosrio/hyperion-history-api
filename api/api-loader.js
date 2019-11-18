const chain = process.env.CHAIN;
process.title = `hyp-${chain}-api`;

const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

const Redis = require('ioredis');
const ioRedisClient = new Redis(manager.redisOptions.port, manager.redisOptions.host);

const api_rate_limit = {
    max: 1000,
    whitelist: [],
    timeWindow: '1 minute',
    redis: ioRedisClient
};

const fastify = require('fastify')({ignoreTrailingSlash: true, trustProxy: true});

if (process.env.ENABLE_WEBSOCKET === 'true') {
    const {SocketManager} = require("./socketManager");
    const socketManager = new SocketManager(fastify);
}

// Register fastify plugins
fastify.register(require('fastify-elasticsearch'), {client: manager.elasticsearchClient});
fastify.register(require('fastify-oas'), require('./config/openApi').options);
fastify.register(require('fastify-cors'));
fastify.register(require('fastify-formbody'));
fastify.register(require('fastify-redis'), manager.redisOptions);
fastify.register(require('./plugins/eosjs'));
fastify.register(require('fastify-rate-limit'), api_rate_limit);

// Register fastify api routes
const AutoLoad = require('fastify-autoload');
const path = require('path');
fastify.register(AutoLoad, {dir: path.join(__dirname, 'handlers', 'v1-history'), options: {prefix: '/v1/history'}});
fastify.register(AutoLoad, {dir: path.join(__dirname, 'handlers', 'v1-chain'), options: {prefix: '/v1/chain'}});
fastify.register(AutoLoad, {dir: path.join(__dirname, 'handlers', 'history'), options: {prefix: '/v2/history'}});
fastify.register(AutoLoad, {dir: path.join(__dirname, 'handlers', 'state'), options: {prefix: '/v2/state'}});
fastify.register(require('./handlers/health'), {prefix: '/v2'});

// allow parsing any content type
fastify.addContentTypeParser('*', (req, done) => {
    let data = '';
    req.on('data', chunk => {
        data += chunk;
    });
    req.on('end', () => {
        done(null, data);
    });
    req.on('error', (err) => {
        console.log('---- Content Parsing Error -----');
        console.log(err);
    });
});

// Launch OpenApi docs when ready
fastify.ready().then(async () => {
    await fastify.oas();
    console.log(chain + ' api ready!');
}, (err) => {
    console.log('an error happened', err)
});

(async () => {
    try {
        await fastify.listen({port: process.env.SERVER_PORT, host: process.env.SERVER_ADDR});
        console.log(`server listening on ${fastify.server.address().port}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1)
    }
})();
