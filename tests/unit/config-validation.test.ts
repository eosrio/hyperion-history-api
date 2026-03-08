import { describe, it, expect } from 'bun:test';
import { HyperionConfigSchema, HyperionApiConfigSchema, HyperionSettingsConfigSchema } from '../../src/interfaces/hyperionConfig.js';

// Minimal valid configuration fixtures
const validSettings = {
    auto_mode_switch: false,
    ds_profiling: false,
    max_ws_payload_mb: 256,
    preview: false,
    chain: 'eos',
    parser: '3.2',
    auto_stop: 0,
    index_version: 'v1',
    debug: false,
    rate_monitoring: false,
    bp_logs: false,
    allow_custom_abi: false,
    index_partition_size: 10000000,
    es_replicas: 0,
};

const validApi = {
    access_log: false,
    chain_name: 'EOS Mainnet',
    server_port: 7000,
    stream_port: 1234,
    server_addr: '127.0.0.1',
    server_name: 'https://eos.hyperion.eosrio.io',
    provider_name: 'EOS Rio',
    provider_url: 'https://eosrio.io',
    chain_logo_url: 'https://example.com/logo.png',
    enable_caching: true,
    cache_life: 1,
    limits: {},
};

const validFullConfig = {
    api: validApi,
    settings: validSettings,
    hub: { enabled: false, instance_key: '' },
    scaling: {
        polling_interval: 10000,
        resume_trigger: 5000,
        max_queue_limit: 50000,
        block_queue_limit: 10000,
        routing_mode: 'round_robin',
        batch_size: 5000,
        readers: 2,
        ds_queues: 4,
        ds_threads: 4,
        ds_pool_size: 2,
        indexing_queues: 2,
        ad_idx_queues: 2,
        dyn_idx_queues: 2,
        max_autoscale: 4,
        auto_scale_trigger: 20000,
    },
    indexer: {
        start_on: 0,
        stop_on: 0,
        rewrite: false,
        purge_queues: false,
        live_reader: true,
        live_only_mode: false,
        abi_scan_mode: false,
        fetch_block: true,
        fetch_traces: true,
        disable_reading: false,
        disable_indexing: false,
        process_deltas: true,
    },
    blacklists: { actions: [], deltas: [] },
    whitelists: { max_depth: 10, root_only: false, actions: [], deltas: [] },
    features: {
        streaming: { enable: false, traces: false, deltas: false },
        tables: { permissions: true, proposals: true, accounts: true, voters: true },
        contract_state: { enabled: false, contracts: {} },
        index_deltas: true,
        index_transfer_memo: true,
        index_all_deltas: false,
        deferred_trx: false,
        failed_trx: false,
        resource_usage: false,
        resource_limits: false,
    },
    prefetch: { read: 50, block: 100, index: 500 },
    experimental: {},
    plugins: {},
};

describe('HyperionSettingsConfigSchema', () => {
    it('should validate a valid settings object', () => {
        const result = HyperionSettingsConfigSchema.safeParse(validSettings);
        expect(result.success).toBe(true);
    });

    it('should reject when required fields are missing', () => {
        const result = HyperionSettingsConfigSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('should accept optional fields', () => {
        const result = HyperionSettingsConfigSchema.safeParse({
            ...validSettings,
            use_global_agent: true,
            process_prefix: 'hyp',
            ship_request_rev: '3.0',
            bp_monitoring: true,
            system_contract: 'eosio',
            max_retained_blocks: 1000000,
        });
        expect(result.success).toBe(true);
    });

    it('should validate tiered index allocation', () => {
        const result = HyperionSettingsConfigSchema.safeParse({
            ...validSettings,
            tiered_index_allocation: {
                enabled: true,
                max_age_days: 30,
                require_node_attributes: { box_type: 'hot' },
            },
        });
        expect(result.success).toBe(true);
    });
});

describe('HyperionApiConfigSchema', () => {
    it('should validate a valid API config', () => {
        const result = HyperionApiConfigSchema.safeParse(validApi);
        expect(result.success).toBe(true);
    });

    it('should reject when required fields are missing', () => {
        const result = HyperionApiConfigSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('should accept rate limit configuration', () => {
        const result = HyperionApiConfigSchema.safeParse({
            ...validApi,
            disable_rate_limit: false,
            rate_limit_rpm: 1000,
            rate_limit_allow: ['127.0.0.1', '10.0.0.1'],
        });
        expect(result.success).toBe(true);
    });

    it('should accept tx_cache_expiration_sec as number or string', () => {
        const asNumber = HyperionApiConfigSchema.safeParse({
            ...validApi,
            tx_cache_expiration_sec: 3600,
        });
        expect(asNumber.success).toBe(true);

        const asString = HyperionApiConfigSchema.safeParse({
            ...validApi,
            tx_cache_expiration_sec: '3600',
        });
        expect(asString.success).toBe(true);
    });

    it('should validate API limits', () => {
        const result = HyperionApiConfigSchema.safeParse({
            ...validApi,
            limits: {
                get_actions: 1000,
                get_tokens: 500,
                get_key_accounts: 100,
            },
        });
        expect(result.success).toBe(true);
    });
});

describe('HyperionConfigSchema (full)', () => {
    it('should validate a complete valid configuration', () => {
        const result = HyperionConfigSchema.safeParse(validFullConfig);
        expect(result.success).toBe(true);
    });

    it('should reject incomplete configuration', () => {
        const result = HyperionConfigSchema.safeParse({ api: validApi });
        expect(result.success).toBe(false);
    });

    it('should accept plugins with arbitrary keys', () => {
        const result = HyperionConfigSchema.safeParse({
            ...validFullConfig,
            plugins: {
                'custom-plugin': { enabled: true, option1: 'value1' },
                'another-plugin': { enabled: false },
            },
        });
        expect(result.success).toBe(true);
    });

    it('should accept contract_state with MongoDB index definitions', () => {
        const result = HyperionConfigSchema.safeParse({
            ...validFullConfig,
            features: {
                ...validFullConfig.features,
                contract_state: {
                    enabled: true,
                    contracts: {
                        'eosio.token': {
                            accounts: {
                                auto_index: true,
                                indices: {
                                    balance: 1,
                                    symbol: 'text',
                                },
                            },
                        },
                    },
                },
            },
        });
        expect(result.success).toBe(true);
    });
});
