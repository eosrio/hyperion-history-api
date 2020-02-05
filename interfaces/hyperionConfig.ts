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
    eosio_alias: string;
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
