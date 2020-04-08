import * as Fastify from "fastify";
import {IncomingMessage, Server, ServerResponse} from "http";

// fastify plugins
import * as fastify_elasticsearch from 'fastify-elasticsearch';
import * as fastify_oas from 'fastify-oas';
import * as fastify_cors from 'fastify-cors';
import * as fastify_formbody from 'fastify-formbody';
import * as fastify_redis from 'fastify-redis';
import * as fastify_rate_limit from 'fastify-rate-limit';

// custom plugins
import fastify_eosjs from "./plugins/fastify-eosjs";

export function registerPlugins(server: Fastify.FastifyInstance<Server, IncomingMessage, ServerResponse>, params: any) {
    server.register(fastify_elasticsearch, params.fastify_elasticsearch);
    server.register(fastify_oas, params.fastify_oas);
    server.register(fastify_cors);
    server.register(fastify_formbody);
    server.register(fastify_redis, params.fastify_redis);
    server.register(fastify_eosjs, params.fastify_eosjs);
    server.register(fastify_rate_limit, params.fastify_rate_limit);
}
