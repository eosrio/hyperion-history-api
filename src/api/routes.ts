import {FastifyError, FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {createReadStream} from "fs";
import {addSharedSchemas, handleChainApiRedirect} from "./helpers/functions.js";
import {fastifyAutoload} from '@fastify/autoload';
import got from "got";
import {resolve} from "node:path";
import {hLog} from "../helpers/common_functions.js";

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
    server.register(fastifyAutoload, {
        dir: resolve('dist', 'api', 'routes', handlersPath),
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

            console.log(request.url);

            await handleChainApiRedirect(request, reply, server);
        }
    });

    // /v1/node/get_supported_apis
    server.route({
        url: '/v1/node/get_supported_apis',
        method: ["GET"],
        schema: {summary: "Get list of supported APIs", tags: ["node"]},
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
            const response = {apis: []} as { apis: string[], error?: string };
            const apiSet = new Set(server.routeSet);
            try {
                const data = await got.get(`${server.chain_api}/v1/node/get_supported_apis`).json() as any;
                if (data.apis && data.apis.length > 0) {
                    data.apis.forEach((a: string) => apiSet.add(a));
                    response.apis = [...apiSet];
                }
            } catch (e: any) {
                hLog(e.message);
            }
            if (response.apis.length === 0) {
                response.apis = [...server.routeSet];
                response.error = 'nodeos did not send any data';
            }
            reply.send(response);
        }
    });

    server.addHook('onError', (request: FastifyRequest, reply: FastifyReply, error: FastifyError, done) => {
        console.log(`[${request.headers['x-real-ip'] || request.ip}] ${request.method} ${request.url} failed >> ${error.message}`);
        done();
    });

    if (server.manager.config.features.streaming) {
        // steam client lib
        server.get(
            '/stream-client.js',
            {schema: {tags: ['internal']}},
            (request: FastifyRequest, reply: FastifyReply) => {
                const stream = createReadStream('./node_modules/@eosrio/hyperion-stream-client/dist/hyperion-stream-client.js');
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
