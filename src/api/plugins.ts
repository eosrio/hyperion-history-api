import * as Fastify from "fastify";
import {IncomingMessage, Server, ServerResponse} from "http";

// fastify plugins
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyCors from '@fastify/cors';
import formBodyPlugin from '@fastify/formbody';
import fastifyRedis from '@fastify/redis';
import fastifyElasticsearch from "@fastify/elasticsearch";
import fastifyRateLimit from '@fastify/rate-limit';

// custom plugins
import fastify_eosjs from "./plugins/fastify-eosjs.js";
import fastifyStatic from "@fastify/static";

export async function registerPlugins(server: Fastify.FastifyInstance<Server, IncomingMessage, ServerResponse>, params: any) {
    server.register(fastifyElasticsearch, params.fastify_elasticsearch);
    server.register(fastifyCors);
    server.register(formBodyPlugin);
    server.register(fastifyRedis, params.fastify_redis);
    if (params.fastify_rate_limit) {
        server.register(fastifyRateLimit, params.fastify_rate_limit);
    }
    server.register(fastify_eosjs, params.fastify_eosjs);
    if (params.fastify_swagger && params.fastify_swagger_ui) {
        await server.register(fastifySwagger, params.fastify_swagger);
        await server.register(fastifySwaggerUi, params.fastify_swagger_ui);
    }
    await server.register(fastifyStatic, params.fastify_static);
}
