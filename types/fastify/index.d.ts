import {FastifyRedis} from "@fastify/redis";
import {StateHistorySocket} from "../../src/indexer/connections/state-history.js";
import {ConnectionManager} from "../../src/indexer/connections/manager.class.js";
import {CacheManager} from "../../src/api/helpers/cacheManager.js";
import {Client} from "@elastic/elasticsearch";
import {AccountObject, ChainAPI} from "@wharfkit/antelope";
import {SavedAbi} from "../../src/interfaces/hyperion-abi.js";

declare module 'fastify' {
    export interface FastifyInstance {
        elastic: Client;
        manager: ConnectionManager;
        explorerTheme?: Record<string, any>
        shs: StateHistorySocket;
        elastic_version: string;
        cacheManager: CacheManager;
        redis: FastifyRedis;
        antelope: {
            chain: ChainAPI,
            getHeadBlockNum: () => Promise<number | undefined>;
            getAbi: (account: string) => Promise<SavedAbi | undefined>;
            getAccountUntyped: (account: string) => Promise<any | undefined>;
        };
        chain_api: string;
        push_api: string;
        tokenCache: Map<string, any>;
        allowedActionQueryParamSet: Set<string>;
        routeSet: Set<string>;
    }
}
