export interface ScalingConfigs {
    batch_size: number;
    queue_limit: number;
    readers: number;
    ds_queues: number;
    ds_threads: number;
    ds_pool_size: number;
    indexing_queues: number;
    ad_idx_queues: number;
    "max_autoscale": number;
    "auto_scale_trigger": number;
}

export interface MainSettings {
    ipc_debug_rate?: number;
    bp_monitoring?: boolean;
    preview: boolean;
    chain: string;
    eosio_alias: string;
    parser: string;
    auto_stop: number;
    index_version: string;
    debug: boolean;
    rate_monitoring: boolean;
    bp_logs: boolean;
    dsp_parser: boolean;
    allow_custom_abi: boolean;
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
    max_inline: number;
}

interface ApiLimits {
    get_links?: number;
    get_actions?: number;
    get_blocks?: number;
    get_created_accounts?: number;
    get_deltas?: number;
    get_key_accounts?: number;
    get_proposals?: number;
    get_tokens?: number;
    get_transfers?: number;
    get_voters?: number;
    get_trx_actions?: number;
}

interface ApiConfigs {
    chain_api_error_log?: boolean;
    chain_api?: string;
    push_api?: string;
    enable_explorer?: boolean;
    access_log: boolean;
    chain_name: string;
    server_port: number;
    server_addr: string;
    server_name: string;
    provider_name: string;
    provider_url: string;
    chain_logo_url: string;
    enable_caching: boolean,
    cache_life: number;
    limits: ApiLimits
}

export interface HyperionConfig {
    settings: MainSettings;
    scaling: ScalingConfigs;
    indexer: IndexerConfigs;

    api: ApiConfigs;

    blacklists: {
        actions: string[],
        deltas: string[]
    };

    whitelists: {
        actions: string[],
        deltas: string[]
    };

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
    };

    prefetch: {
        read: number,
        block: number,
        index: number
    };

    experimental: any;
}
