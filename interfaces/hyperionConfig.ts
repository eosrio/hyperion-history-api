import {AlertManagerOptions} from "../modules/alertsManager";

export interface ScalingConfigs {
    polling_interval: number;
    resume_trigger: number;
    max_queue_limit: number;
    block_queue_limit: number;
    routing_mode: string;
    batch_size: number;
    queue_limit: number;
    readers: number;
    ds_queues: number;
    ds_threads: number;
    ds_pool_size: number;
    indexing_queues: number;
    ad_idx_queues: number;
    dyn_idx_queues: number;
    max_autoscale: number;
    auto_scale_trigger: number;
}

export interface MainSettings {
    use_global_agent?: boolean;
    process_prefix?: string;
    ignore_snapshot?: boolean;
    ship_request_rev: string;
    custom_policy: string;
    bypass_index_map: boolean;
    hot_warm_policy: boolean;
    auto_mode_switch: boolean;
    ds_profiling: boolean;
    max_ws_payload_mb: number;
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
    index_partition_size: number;
    es_replicas: number;
}

export interface IndexerConfigs {
    enabled?: boolean;
    node_max_old_space_size?: number;
    fill_state: boolean;
    start_on: number;
    stop_on: number;
    rewrite: boolean;
    purge_queues: boolean;
    live_reader: boolean;
    live_only_mode: boolean;
    abi_scan_mode: boolean;
    fetch_block: boolean;
    fetch_traces: boolean;
    fetch_deltas: boolean;
    disable_reading: boolean;
    disable_indexing: boolean;
    process_deltas: boolean;
    repair_mode: boolean;
    max_inline: number;
    disable_delta_rm?: boolean;
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

interface CachedRouteConfig {
    path: string;
    ttl: number
}

interface ApiConfigs {
    log_errors?: boolean;
    stream_scroll_batch?: number;
    stream_scroll_limit?: number;
    enabled?: boolean;
    pm2_scaling?: number;
    node_max_old_space_size?: number;
    disable_rate_limit?: boolean;
    disable_tx_cache?: boolean;
    tx_cache_expiration_sec?: number | string;
    rate_limit_rpm?: number;
    rate_limit_allow?: string[];
    custom_core_token?: string;
    chain_api_error_log?: boolean;
    chain_api?: string;
    push_api?: string;
    access_log: boolean;
    chain_name: string;
    server_port: number;
    stream_port: number;
    server_addr: string;
    server_name: string;
    provider_name: string;
    provider_url: string;
    provider_logo: string;
    chain_logo_url: string;
    enable_caching: boolean,
    cache_life: number;
    limits: ApiLimits,
    v1_chain_cache?: CachedRouteConfig[]
}

interface HubLocation {
    city: string,
    country: string,
    lat: number,
    lon: number
}

interface HyperionHubConfigs {
    location: HubLocation;
    production: boolean;
    publisher_key: string;
    inform_url: string;
}

export interface HyperionConfig {
    api: ApiConfigs;
    settings: MainSettings;
    hub: HyperionHubConfigs;
    scaling: ScalingConfigs;
    indexer: IndexerConfigs;
    blacklists: {
        actions: string[],
        deltas: string[]
    };
    whitelists: {
        max_depth: number;
        root_only: boolean,
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
        index_all_deltas: boolean,
        deferred_trx: boolean,
        failed_trx: boolean,
        resource_usage: boolean,
        resource_limits: boolean,
    };
    prefetch: {
        read: number,
        block: number,
        index: number
    };
    experimental: any;
    plugins: {
        [key: string]: any;
    };
    alerts: AlertManagerOptions;
}
