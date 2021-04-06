import {join} from "path";
import {FastifyError, FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {createReadStream} from "fs";
import {addSharedSchemas, handleChainApiRedirect} from "./helpers/functions";
import autoLoad from 'fastify-autoload';

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

	server.addHook('onError', (request: FastifyRequest, reply: FastifyReply, error: FastifyError, done) => {
		console.log(`[${request.headers['x-real-ip']}] ${request.method} ${request.url} failed with error: ${error.message}`);
		done();
	});

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
