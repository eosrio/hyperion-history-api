import {Api, JsonRpc} from "eosjs";
import {FastifyRedis} from "@fastify/redis";
import {StateHistorySocket} from "../../src/indexer/connections/state-history.js";
import {ConnectionManager} from "../../src/indexer/connections/manager.class.js";
import {CacheManager} from "../../src/api/helpers/cacheManager.js";

declare module 'fastify' {
    export interface FastifyInstance {
        manager: ConnectionManager;
        explorerTheme?: Record<string, any>
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
