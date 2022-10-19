import * as Fastify from "fastify";
import {IncomingMessage, Server, ServerResponse} from "http";

// fastify plugins
import fastifyElasticsearch from '@fastify/elasticsearch';
import {fastifySwagger} from '@fastify/swagger';
import fastifyCors from '@fastify/cors';
import fastifyFormbody from '@fastify/formbody';
import fastifyRedis from '@fastify/redis';
import fastifyRateLimit from '@fastify/rate-limit';

// custom plugins
import fastify_eosjs from "./plugins/fastify-eosjs.js";

export function registerPlugins(server: Fastify.FastifyInstance<Server, IncomingMessage, ServerResponse>, params: any) {
    server.register(fastifyElasticsearch, params.fastify_elasticsearch);

    if (params.fastify_swagger) {
        server.register(fastifySwagger, params.fastify_swagger);
    }

    server.register(fastifyCors.default);

    server.register(fastifyFormbody.default);

    server.register(fastifyRedis.default, params.fastify_redis);

    if (params.fastify_rate_limit) {
        server.register(fastifyRateLimit.default, params.fastify_rate_limit);
    }

    server.register(fastify_eosjs, params.fastify_eosjs);
}
