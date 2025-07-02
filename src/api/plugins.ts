import * as Fastify from "fastify";
import {IncomingMessage, Server, ServerResponse} from "http";

// fastify plugins
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyCors from '@fastify/cors';
import formBodyPlugin from '@fastify/formbody';
import fastifyRedis from '@fastify/redis';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from "@fastify/static";
import fastifyMongodb from "@fastify/mongodb";

// custom plugins
import fastify_antelope from "./plugins/fastify-antelope.js";

export async function registerPlugins(server: Fastify.FastifyInstance<Server, IncomingMessage, ServerResponse>, params: any) {

    if (params.fastify_mongo) {
        server.register(fastifyMongodb, params.fastify_mongo);
    }

    server.register(fastifyCors);
    server.register(formBodyPlugin);
    server.register(fastifyRedis, params.fastify_redis);

    if (params.fastify_rate_limit) {
        server.register(fastifyRateLimit, params.fastify_rate_limit);
    }

    server.register(fastify_antelope, params.fastify_antelope);

    if (params.fastify_swagger && params.fastify_swagger_ui) {
        await server.register(fastifySwagger, params.fastify_swagger);
        await server.register(fastifySwaggerUi, params.fastify_swagger_ui);
    }
    await server.register(fastifyStatic, params.fastify_static);
}
