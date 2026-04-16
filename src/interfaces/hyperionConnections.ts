import {LabelledShipNode} from "../indexer/connections/state-history.js";
import {AlertManagerOptions} from "../indexer/modules/alertsManager.js";

export interface AmqpConfig {
    host: string;
    api: string;
    protocol: string;
    user: string;
    pass: string;
    vhost: string;
    frameMax: string;
}

export interface ESConfig {
    protocol: string;
    host: string;
    ingest_nodes: string[];
    user: string;
    pass: string;
}

export interface HyperionChainData {
    name: string;
    chain_id: string;
    http: string;
    ship: string | (string | LabelledShipNode)[];
    WS_ROUTER_PORT: number;
    WS_ROUTER_HOST: string;
    control_port: number;
}

/**
 * Redis connection config. The entire object is handed to ioredis via
 * `new Redis(conn.redis)` (see api/server.ts, indexer/modules/master.ts,
 * indexer/workers/ds-pool.ts, api/socketManager.ts), so any ioredis
 * option works in practice. The previous form of this interface only
 * declared `host` and `port`, which obscured the fact that auth and
 * Sentinel mode are both supported. The common fields are now surfaced
 * explicitly; `[key: string]: unknown` preserves pass-through for the rest.
 *
 * Single-primary mode: set `host` + `port`.
 * Sentinel mode: omit `host`/`port`, set `sentinels[]` + `name`.
 */
export interface RedisConfig {
    host?: string;
    port?: number;
    // ACL auth for the primary (Redis 6+).
    username?: string;
    password?: string;
    db?: number;
    tls?: Record<string, unknown>;
    // Sentinel mode: ioredis queries the sentinel quorum to locate the
    // current primary. Host/port above should be omitted when this is set.
    sentinels?: { host: string; port: number }[];
    name?: string;
    sentinelUsername?: string;
    sentinelPassword?: string;
    // Forward any other ioredis option verbatim.
    [key: string]: unknown;
}

export interface MongoDbConfig {
    enabled: boolean;
    host: string;
    port: number;
    database_prefix: string;
    user: string;
    pass: string;
}

export interface HyperionConnections {
    amqp: AmqpConfig;
    elasticsearch: ESConfig;
    redis: RedisConfig;
    mongodb: MongoDbConfig;
    chains: {
        [key: string]: HyperionChainData;
    },
    alerts?: AlertManagerOptions;
}
