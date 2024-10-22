import {ConnectionManager} from "../../connections/manager.class";
import {Api, JsonRpc} from "eosjs";
import {CacheManager} from "../../api/helpers/cacheManager";
import {FastifyRedis} from "@fastify/redis";
import {StateHistorySocket} from "../../connections/state-history";

declare module 'fastify' {
    export interface FastifyInstance {
        manager: ConnectionManager;
        shs: StateHistorySocket;
        elastic_version: string;
        cacheManager: CacheManager;
        redis: FastifyRedis;
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
