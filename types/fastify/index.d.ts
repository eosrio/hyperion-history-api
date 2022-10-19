import {Client} from "@elastic/elasticsearch";
import {ConnectionManager} from "../../src/connections/manager.class.js";
import {Api, JsonRpc} from "enf-eosjs";
import {CacheManager} from "../../src/api/helpers/cacheManager.js";
import {FastifyRedis} from "@fastify/redis";

declare module 'fastify' {
    export interface FastifyInstance {
        manager: ConnectionManager;
        cacheManager: CacheManager;
        redis: FastifyRedis;
        elastic: Client;
        eosjs: {
            rpc: JsonRpc;
            api: Api;
        };
        chain_api: string;
        push_api: string;
        tokenCache: Map<string, any>;
        allowedActionQueryParamSet: Set<string>;
        routeSet: Set<string>;
    }
}
