import {IncomingMessage, Server, ServerResponse} from "http";
import {Client} from "@elastic/elasticsearch";
import {Redis} from "ioredis";
import {ConnectionManager} from "../../connections/manager.class";
import {JsonRpc, Api} from "eosjs/dist";

declare module 'fastify' {

    export interface FastifyInstance<HttpServer = Server,
        HttpRequest = IncomingMessage,
        HttpResponse = ServerResponse,
        > {
        manager: ConnectionManager
        redis: Redis;
        elastic: Client;
        eosjs: {
            rpc: JsonRpc,
            api: Api
        }
    }
}
