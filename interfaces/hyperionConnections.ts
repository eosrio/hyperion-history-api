import {LabelledShipNode} from "../connections/state-history";

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

export interface RedisConfig {
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
