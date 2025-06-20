import { z } from "zod/v4";

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
    require_node_attributes?: { [key: string]: string };
    include_node_attributes?: { [key: string]: string };
    exclude_node_attributes?: { [key: string]: string };
}

export interface MainSettings {
    use_global_agent?: boolean;
    process_prefix?: string;
    ignore_snapshot?: boolean;
    ship_request_rev?: string;
    // custom_policy: string; // REMOVED
    // hot_warm_policy: boolean; // REMOVED
    auto_mode_switch: boolean;
    ds_profiling: boolean;
    max_ws_payload_mb: number;
    ipc_debug_rate?: number;
    bp_monitoring?: boolean;
    preview: boolean;
    chain: string;
    eosio_alias?: string; // Deprecated, use system_contract
    system_contract?: string; 
    parser: string;
    auto_stop: number;
    index_version: string;
    debug: boolean;
    rate_monitoring: boolean;
    bp_logs: boolean;
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

    start_on: number;
    stop_on: number;
    rewrite: boolean;
    purge_queues: boolean;
    live_reader: boolean;
    live_only_mode: boolean;
    abi_scan_mode: boolean;
    fetch_block: boolean;
    fetch_traces: boolean;
    fetch_deltas?: boolean;
    disable_reading: boolean;
    disable_indexing: boolean;
    process_deltas: boolean;
    max_inline?: number;
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
    provider_logo?: string;
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
    oracle?: {
        custom_mode?: string;
        pair?: string;
        contract?: string;
        table?: string;
        path?: string;
        type?: string;
        factor?: number;
    }
}

interface HyperionHubConfigs {
    enabled: boolean;
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
            permissions: boolean,
            proposals: boolean,
            accounts: boolean,
            voters: boolean,
            user_resources?: boolean
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
        contract_console?: boolean
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

// Zod schema for API limits
const ApiLimitsSchema = z.object({
    get_table_rows: z.number().optional(),
    get_top_holders: z.number().optional(),
    get_links: z.number().optional(),
    get_actions: z.number().optional(),
    get_blocks: z.number().optional(),
    get_created_accounts: z.number().optional(),
    get_deltas: z.number().optional(),
    get_key_accounts: z.number().optional(),
    get_proposals: z.number().optional(),
    get_tokens: z.number().optional(),
    get_transfers: z.number().optional(),
    get_voters: z.number().optional(),
    get_trx_actions: z.number().optional(),
});

// Zod schema for cached route configuration
const CachedRouteConfigSchema = z.object({
    path: z.string(),
    ttl: z.number()
});

// Zod schema for explorer configurations
const ExplorerConfigsSchema = z.object({
    home_redirect: z.boolean().optional(),
    theme: z.string().optional(),
    upstream: z.string().optional(),
});

export const HyperionApiConfigSchema = z.object({
    enabled: z.boolean().optional(),
    log_errors: z.boolean().optional(),
    stream_scroll_batch: z.number().optional(),
    stream_scroll_limit: z.number().optional(),
    pm2_scaling: z.number().optional(),
    
    // Node.js options
    node_max_old_space_size: z.number().optional(),
    node_trace_deprecation: z.boolean().optional(),
    node_trace_warnings: z.boolean().optional(),
    
    disable_rate_limit: z.boolean().optional(),
    disable_tx_cache: z.boolean().optional(),
    tx_cache_expiration_sec: z.union([z.number(), z.string()]).optional(),
    rate_limit_rpm: z.number().optional(),
    rate_limit_allow: z.array(z.string()).optional(),
    custom_core_token: z.string().optional(),
    chain_api_error_log: z.boolean().optional(),
    chain_api: z.string().optional(),
    push_api: z.string().optional(),
    access_log: z.boolean(),
    chain_name: z.string(),
    server_port: z.number(),
    stream_port: z.number(),
    server_addr: z.string(),
    server_name: z.string(),
    provider_name: z.string(),
    provider_url: z.string(),
    provider_logo: z.string().optional(),
    chain_logo_url: z.string(),
    enable_caching: z.boolean(),
    cache_life: z.number(),
    limits: ApiLimitsSchema,
    v1_chain_cache: z.array(CachedRouteConfigSchema).optional(),
    explorer: ExplorerConfigsSchema.optional(),
});

// Zod schema for tiered index allocation settings
const TieredIndexAllocationSettingsSchema = z.object({
    enabled: z.boolean(),
    max_age_days: z.number().optional(),
    max_age_blocks: z.number().optional(),
    require_node_attributes: z.record(z.string(), z.string()).optional(),
    include_node_attributes: z.record(z.string(), z.string()).optional(),
    exclude_node_attributes: z.record(z.string(), z.string()).optional(),
});

export const HyperionSettingsConfigSchema = z.object({
    use_global_agent: z.boolean().optional(),
    process_prefix: z.string().optional(),
    ignore_snapshot: z.boolean().optional(),
    ship_request_rev: z.string().optional(),
    auto_mode_switch: z.boolean(),
    ds_profiling: z.boolean(),
    max_ws_payload_mb: z.number(),
    ipc_debug_rate: z.number().optional(),
    bp_monitoring: z.boolean().optional(),
    preview: z.boolean(),
    chain: z.string(),
    eosio_alias: z.string().optional(),
    system_contract: z.string().optional(),
    parser: z.string(),
    auto_stop: z.number(),
    index_version: z.string(),
    debug: z.boolean(),
    rate_monitoring: z.boolean(),
    bp_logs: z.boolean(),
    allow_custom_abi: z.boolean(),
    index_partition_size: z.number(),
    max_retained_blocks: z.number().optional(),
    es_replicas: z.number(),
    tiered_index_allocation: TieredIndexAllocationSettingsSchema.optional(),
});

// Zod schema for scaling configurations
const ScalingConfigsSchema = z.object({
    polling_interval: z.number(),
    resume_trigger: z.number(),
    max_queue_limit: z.number(),
    block_queue_limit: z.number(),
    routing_mode: z.string(),
    batch_size: z.number(),
    readers: z.number(),
    ds_queues: z.number(),
    ds_threads: z.number(),
    ds_pool_size: z.number(),
    indexing_queues: z.number(),
    ad_idx_queues: z.number(),
    dyn_idx_queues: z.number(),
    max_autoscale: z.number(),
    auto_scale_trigger: z.number(),
});

// Zod schema for indexer configurations
const IndexerConfigsSchema = z.object({
    enabled: z.boolean().optional(),
    
    // Node.js options
    node_max_old_space_size: z.number().optional(),
    node_trace_deprecation: z.boolean().optional(),
    node_trace_warnings: z.boolean().optional(),

    start_on: z.number(),
    stop_on: z.number(),
    rewrite: z.boolean(),
    purge_queues: z.boolean(),
    live_reader: z.boolean(),
    live_only_mode: z.boolean(),
    abi_scan_mode: z.boolean(),
    fetch_block: z.boolean(),
    fetch_traces: z.boolean(),
    fetch_deltas: z.boolean().optional(),
    disable_reading: z.boolean(),
    disable_indexing: z.boolean(),
    process_deltas: z.boolean(),
    max_inline: z.number().optional(),
});

// Zod schema for hub configurations
const HyperionHubConfigsSchema = z.object({
    enabled: z.boolean(),
    instance_key: z.string(),
    hub_url: z.string().optional(),
    custom_indexer_controller: z.string().optional(),
});

// Zod schema for blacklists and whitelists
const BlacklistsSchema = z.object({
    actions: z.array(z.string()),
    deltas: z.array(z.string())
});

const WhitelistsSchema = z.object({
    max_depth: z.number(),
    root_only: z.boolean(),
    actions: z.array(z.string()),
    deltas: z.array(z.string())
});

// Zod schema for features
const StreamingFeaturesSchema = z.object({
    enable: z.boolean(),
    traces: z.boolean(),
    deltas: z.boolean()
});

const TablesFeaturesSchema = z.object({
    permissions: z.boolean(),
    proposals: z.boolean(),
    accounts: z.boolean(),
    voters: z.boolean(),
    user_resources: z.boolean().optional()
});

const ContractStateSchema = z.object({
    enabled: z.boolean().optional(),
    contracts: z.record(z.string(), z.record(z.string(), z.object({
        auto_index: z.boolean(),
        indices: z.record(z.string(), z.union([
            z.literal(1),
            z.literal(-1),
            z.literal("text"),
            z.literal("date"),
            z.literal("2dsphere")
        ]))
    })))
});

const FeaturesSchema = z.object({
    streaming: StreamingFeaturesSchema,
    tables: TablesFeaturesSchema,
    contract_state: ContractStateSchema,
    index_deltas: z.boolean(),
    index_transfer_memo: z.boolean(),
    index_all_deltas: z.boolean(),
    deferred_trx: z.boolean(),
    failed_trx: z.boolean(),
    resource_usage: z.boolean(),
    resource_limits: z.boolean(),
    contract_console: z.boolean().optional()
});

// Zod schema for prefetch
const PrefetchSchema = z.object({
    read: z.number(),
    block: z.number(),
    index: z.number()
});

export const HyperionConfigSchema = z.object({
    api: HyperionApiConfigSchema,
    settings: HyperionSettingsConfigSchema,
    hub: HyperionHubConfigsSchema,
    scaling: ScalingConfigsSchema,
    indexer: IndexerConfigsSchema,
    blacklists: BlacklistsSchema,
    whitelists: WhitelistsSchema,
    features: FeaturesSchema,
    prefetch: PrefetchSchema,
    experimental: z.any(),
    plugins: z.record(z.string(), z.any()),
    alerts: z.any().optional(), // AlertManagerOptions type is imported but not defined in this file
});