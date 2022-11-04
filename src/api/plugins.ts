import * as Fastify from "fastify";
import {IncomingMessage, Server, ServerResponse} from "http";

// fastify ecosystem plugins
import fastifyElasticsearch from '@fastify/elasticsearch';
import fastifySwagger, {SwaggerOptions} from '@fastify/swagger';
import fastifyCors, {FastifyCorsOptions} from '@fastify/cors';
import fastifyFormbody, {FormBodyPluginOptions} from '@fastify/formbody';
import fastifyRedis, {FastifyRedisPluginOptions} from '@fastify/redis';
import fastifyRateLimit, {RateLimitPluginOptions} from '@fastify/rate-limit';

// custom plugins
import fastifyEosjs from "./plugins/fastify-eosjs.js";

export interface ApiPluginOptions {
    fastifyElasticsearch: any;
    fastifySwagger?: SwaggerOptions;
    fastifyEosjs: any;
    fastifyRateLimit?: RateLimitPluginOptions;
    fastifyRedis: FastifyRedisPluginOptions;
    fastifyFormbody?: FormBodyPluginOptions;
    fastifyCors: FastifyCorsOptions;
}

export function registerPlugins(server: Fastify.FastifyInstance<Server, IncomingMessage, ServerResponse>, params: ApiPluginOptions) {

    server.register(fastifyCors.default, params.fastifyCors);
    server.register(fastifyFormbody.default, params.fastifyFormbody);
    server.register(fastifyElasticsearch.default, params.fastifyElasticsearch);
    server.register(fastifyRedis.default, params.fastifyRedis);
    server.register(fastifyEosjs, params.fastifyEosjs);

    if (params.fastifyRateLimit) {
        server.register(fastifyRateLimit.default, params.fastifyRateLimit);
    }

    if (params.fastifySwagger) {
        server.register(fastifySwagger.default, params.fastifySwagger as SwaggerOptions);
    }
}
