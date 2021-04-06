import * as Fastify from "fastify";
import {IncomingMessage, Server, ServerResponse} from "http";

// fastify plugins
import * as fastifyElasticsearch from 'fastify-elasticsearch';
import fastifySwagger from 'fastify-swagger';
import fastifyCors from 'fastify-cors';
import fastifyFormbody from 'fastify-formbody';
import fastifyRedis from 'fastify-redis';
import fastifyRateLimit from 'fastify-rate-limit';

// custom plugins
import fastify_eosjs from "./plugins/fastify-eosjs";

export function registerPlugins(server: Fastify.FastifyInstance<Server, IncomingMessage, ServerResponse>, params: any) {
	server.register(fastifyElasticsearch, params.fastify_elasticsearch);
	server.register(fastifySwagger, params.fastify_swagger);
	server.register(fastifyCors);
	server.register(fastifyFormbody);
	server.register(fastifyRedis, params.fastify_redis);
	server.register(fastifyRateLimit, params.fastify_rate_limit);
	server.register(fastify_eosjs, params.fastify_eosjs);
}
