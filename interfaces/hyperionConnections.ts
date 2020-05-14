interface AmqpConfig {
    host: string;
    api: string;
    user: string;
    pass: string;
    vhost: string;
}

interface ESConfig {
    protocol: string;
    host: string;
    ingest_nodes: string[];
    user: string;
    pass: string;
}

interface HyperionChainData {
    name: string;
    chain_id: string;
    http: string;
    WS_ROUTER_PORT: number;
    WS_ROUTER_HOST: string;
}

interface RedisConfig {
    host: string;
    port: number;
}

export interface HyperionConnections {
    amqp: AmqpConfig;
    elasticsearch: ESConfig;
    redis: RedisConfig;
    chains: {
        [key: string]: HyperionChainData
    }
}
