import {AlertManagerOptions} from "../indexer/modules/alertsManager.js";

/**
 * Contract usage statistics structure
 * [0] = Total hits count for this contract
 * [1] = Percentage of total hits (0.0 to 1.0)
 * [2] = Array of worker IDs assigned to handle this contract
 */
export interface ContractUsageEntry {
    0: number;      // Total hits
    1: number;      // Percentage (0.0 to 1.0)
    2: number[];    // Assigned worker IDs
}

/**
 * Global usage map tracking contract activity and worker assignments
 * Key: contract name (e.g., 'eosio', 'eosio.oracle')
 * Value: [hits, percentage, workers]
 */
export interface ContractUsageMap {
    [contractName: string]: ContractUsageEntry;
}

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

export interface NodeAttributeRequirement {
    key: string;
    value: string;
}

export interface TieredIndexAllocationSettings {
    enabled: boolean;
    max_age_days?: number;
    max_age_blocks?: number;
    require_node_attribute?: NodeAttributeRequirement;
}

export interface MainSettings {
    use_global_agent?: boolean;
    process_prefix?: string;
    ignore_snapshot?: boolean;
    ship_request_rev: string;
    // custom_policy: string; // REMOVED
    bypass_index_map: boolean;
    // hot_warm_policy: boolean; // REMOVED
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
    max_retained_blocks?: number;
    es_replicas: number;
    tiered_index_allocation?: TieredIndexAllocationSettings;
}

export interface IndexerConfigs {

    enabled?: boolean;

    // Node.js options
    node_max_old_space_size?: number;
    node_trace_deprecation?: boolean;
    node_trace_warnings?: boolean;

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
    get_table_rows?: number;
    get_top_holders?: number;
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
    enabled?: boolean;
    log_errors?: boolean;
    stream_scroll_batch?: number;
    stream_scroll_limit?: number;
    pm2_scaling?: number;

    // Node.js options
    node_max_old_space_size?: number;
    node_trace_deprecation?: boolean;
    node_trace_warnings?: boolean;

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
    enable_caching: boolean;
    cache_life: number;
    limits: ApiLimits;
    v1_chain_cache?: CachedRouteConfig[];
    explorer?: ExplorerConfigs;
}

interface ExplorerConfigs {
    home_redirect?: boolean;
    theme?: string;
    upstream?: string;
}

interface HyperionHubConfigs {
    enabled: boolean;
    production: boolean;
    instance_key: string;
    hub_url?: string;
    custom_indexer_controller?: string;
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
        contract_state: {
            enabled: boolean;
            contracts:
                {
                    [key: string]: {
                        [key: string]: {
                            auto_index: boolean;
                            indices: {
                                [key: string]: 1 | -1 | "text" | "date" | "2dsphere";
                            }
                        }
                    }
                }
        }
        index_deltas: boolean,
        index_transfer_memo: boolean,
        index_all_deltas: boolean,
        deferred_trx: boolean,
        failed_trx: boolean,
        resource_usage: boolean,
        resource_limits: boolean,
        contract_console: boolean
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
    alerts?: AlertManagerOptions;
}
