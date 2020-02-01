import {existsSync, readFileSync} from "fs";

export interface ScalingConfigs {
    batch_size: number;
    queue_limit: number;
    readers: number;
    ds_queues: number;
    ds_threads: number;
    ds_pool_size: number;
    indexing_queues: number;
    ad_idx_queues: number;
}

export interface MainSettings {
    preview: boolean;
    chain: string;
    parser: string;
    auto_stop: number;
    index_version: string;
    debug: boolean;
    rate_monitoring: boolean;
    bp_logs: boolean;
}

export interface IndexerConfigs {
    start_on: number;
    stop_on: number;
    rewrite: boolean;
    purge_queues: boolean;
    live_reader: boolean;
    live_only_mode: boolean;
    abi_scan_mode: boolean;
    fetch_block: boolean;
    fetch_traces: boolean;
    disable_reading: boolean;
    disable_indexing: boolean;
    process_deltas: boolean;
    repair_mode: boolean;
}

export interface HyperionConfig {
    settings: MainSettings;
    scaling: ScalingConfigs;
    indexer: IndexerConfigs;
    features: {
        streaming: {
            enable: boolean,
            traces: boolean,
            deltas: boolean
        },
        tables: {
            proposals: boolean,
            accounts: boolean,
            voters: boolean,
            userres: boolean,
            delband: boolean
        },
        index_deltas: boolean,
        index_transfer_memo: boolean,
        index_all_deltas: boolean
    },
    prefetch: {
        read: number,
        block: number,
        index: number
    },
    experimental: any;
}

interface AmqpConfig {
    host: string;
    api: string;
    user: string;
    pass: string;
    vhost: string;
}

interface ESConfig {
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
    port: string | number;
}

export interface HyperionConnections {
    amqp: AmqpConfig;
    elasticsearch: ESConfig;
    redis: RedisConfig;
    chains: {
        [key: string]: HyperionChainData
    }
}


export class ConfigurationModule {

    public config: HyperionConfig;
    public connections: HyperionConnections;

    constructor() {
        this.loadConfigJson();
        this.loadConnectionsJson();
    }

    loadConfigJson() {
        if (process.env.CONFIG_JSON) {
            const data = readFileSync(process.env.CONFIG_JSON).toString();
            try {
                this.config = JSON.parse(data);
            } catch (e) {
                console.log(`Failed to Load configuration file ${process.env.CONFIG_JSON}`);
                console.log(e.message);
                process.exit(1);
            }
        } else {
            console.error('Configuration file not specified!');
            process.exit(1);
        }
    }

    loadConnectionsJson() {
        const file = './connections.json';
        if (existsSync(file)) {
            const data = readFileSync(file).toString();
            try {
                this.connections = JSON.parse(data);
            } catch (e) {
                console.log(`Failed to Load ${file}`);
                console.log(e.message);
                process.exit(1);
            }
        } else {
            console.log('connections.json not found!');
            process.exit(1);
        }
    }
}
