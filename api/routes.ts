import {join} from "path";
import {FastifyError, FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {createReadStream} from "fs";
import {addSharedSchemas, handleChainApiRedirect} from "./helpers/functions";
import autoLoad from '@fastify/autoload';
import got from "got";

function addRedirect(server: FastifyInstance, url: string, redirectTo: string) {
    server.route({
        url,
        method: 'GET',
        schema: {
            hide: true
        },
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
            reply.redirect(redirectTo);
        }
    });
}

function addRoute(server: FastifyInstance, handlersPath: string, prefix: string) {
    server.register(autoLoad, {
        dir: join(__dirname, 'routes', handlersPath),
        ignorePattern: /.*(handler|schema).js/,
        dirNameRoutePrefix: false,
        options: {prefix}
    });
}

export function registerRoutes(server: FastifyInstance) {

    // build internal map of routes
    const routeSet = new Set<string>();
    server.decorate('routeSet', routeSet);
    const ignoreList = [
        '/v2',
        '/v2/history',
        '/v2/state',
        '/v1/chain/*',
        '/v1/chain'
    ];
    server.addHook('onRoute', opts => {
        if (!ignoreList.includes(opts.url)) {
            if (opts.url.startsWith('/v')) {
                routeSet.add(opts.url);
            }
        }
    });

    // Register fastify api routes
    addRoute(server, 'v2', '/v2');
    addRoute(server, 'v2-history', '/v2/history');
    addRoute(server, 'v2-state', '/v2/state');
    addRoute(server, 'v2-stats', '/v2/stats');

    // legacy routes
    addRoute(server, 'v1-history', '/v1/history');
    addRoute(server, 'v1-trace', '/v1/trace_api');

    addSharedSchemas(server);

    // chain api redirects
    addRoute(server, 'v1-chain', '/v1/chain');

    // other v1 requests
    server.route({
        url: '/v1/chain/*',
        method: ["GET", "POST"],
        schema: {
            summary: "Wildcard chain api handler",
            tags: ["chain"]
        },
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
            await handleChainApiRedirect(request, reply, server);
        }
    });

    // /v1/node/get_supported_apis
    server.route({
        url: '/v1/node/get_supported_apis',
        method: ["GET"],
        schema: {
            summary: "Get list of supported APIs",
            tags: ["node"]
        },
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
            const data = await got.get(`${server.chain_api}/v1/node/get_supported_apis`).json() as any;
            if (data.apis && data.apis.length > 0) {
                const apiSet = new Set(server.routeSet);
                data.apis.forEach((a) => apiSet.add(a));
                reply.send({apis: [...apiSet]});
            } else {
                reply.send({apis: [...server.routeSet], error: 'nodeos did not send any data'});
            }
        }
    });

    // global onRequest hook to collect hourly statistics for each path on redis
    server.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
        const path = request.url.split('?')[0].replace(/\/$/, '');
        const now = new Date();
        const ts = now.getTime();
        // normalized time in hours
        const factor = 1000 * 60 * 60;
        const ts_hour_unix = Math.floor(ts / factor) * factor;
        const key = `stats:${server.manager.chain}:H:${ts_hour_unix}`;
        // console.log(reply.statusCode, key, new Date(ts_hour_unix));
        server.redis.multi()
            .incr(`stats:${server.manager.chain}:total:${reply.statusCode}:${path}`)
            .zincrby(key, 1, `[${reply.statusCode}]${path}`)
            .expire(key, 60 * 60 * 24 * 7)
            .exec()
            .catch(console.log);
        done();
    });

    if (server.manager.config.api.log_errors) {
        server.addHook('onError', (request: FastifyRequest, reply: FastifyReply, error: FastifyError, done) => {
            console.log(`[${request.headers['x-real-ip'] || request.ip}] ${request.method} ${request.url} failed >> ${error.message}`);
            done();
        });
    }

    if (server.manager.config.features.streaming) {
        // steam client lib
        server.get(
            '/stream-client.js',
            {schema: {tags: ['internal']}},
            (request: FastifyRequest, reply: FastifyReply) => {
                const stream = createReadStream('./hyperion-stream-client.js');
                reply.type('application/javascript').send(stream);
            });
    }

    // Redirect routes to documentation
    addRedirect(server, '/v2', '/v2/docs');
    addRedirect(server, '/v2/history', '/v2/docs/index.html#/history');
    addRedirect(server, '/v2/state', '/v2/docs/index.html#/state');
    addRedirect(server, '/v1/chain', '/v2/docs/index.html#/chain');
    addRedirect(server, '/explorer', '/v2/explore');
    addRedirect(server, '/explore', '/v2/explore');
}
