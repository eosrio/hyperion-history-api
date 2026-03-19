/**
 * IndexerRunner — Generates Hyperion configuration and manages the
 * indexer/API containers inside the Docker Compose stack.
 *
 * Configs are written to `tests/e2e/.run/config/` (sandboxed), never
 * touching the project's main `config/` directory. The indexer and API
 * run as Docker services using `--profile hyperion`.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainEndpoints } from './chain-manager.js';

export interface IndexerRunnerConfig {
    /** Name for the chain (used in ES index prefix, config filenames, etc.) */
    chainName?: string;
    /** Root of the hyperion-history-api project */
    hyperionRoot: string;
    /** Directory containing docker-compose.yml */
    composeDir: string;
    /** Chain endpoints from ChainManager */
    endpoints: ChainEndpoints;
    /** Chain ID from nodeos */
    chainId: string;
    /** Run in live mode (continue after catching up) */
    liveMode?: boolean;
    /** Enable verbose logging */
    verbose?: boolean;
    /** Custom port for the API server */
    apiPort?: number;
    /** Custom port for the WebSocket router */
    wsPort?: number;
    /** Custom control port */
    controlPort?: number;
}

export interface IndexerResult {
    configDir: string;
    chainsDir: string;
    connectionsPath: string;
    chainConfigPath: string;
}

export class IndexerRunner {
    private config: Required<Pick<IndexerRunnerConfig, 'chainName' | 'liveMode' | 'verbose' | 'apiPort' | 'wsPort' | 'controlPort'>> & IndexerRunnerConfig;
    private configDir: string;
    private chainsDir: string;

    constructor(config: IndexerRunnerConfig) {
        this.config = {
            chainName: 'hyp-test',
            liveMode: false,
            verbose: false,
            apiPort: 17000,
            wsPort: 17001,
            controlPort: 17002,
            ...config,
        };
        // Sandboxed config: tests/e2e/.run/config/
        this.configDir = join(this.config.composeDir, '.run', 'config');
        this.chainsDir = join(this.configDir, 'chains');
    }

    /**
     * Generate connections.json with Docker-internal hostnames.
     * Because the indexer and API run inside the Docker network,
     * they use service names (e.g. `elasticsearch`) not `127.0.0.1`.
     */
    generateConnectionsConfig(): string {
        const { chainName, chainId, wsPort, controlPort } = this.config;

        const connections = {
            amqp: {
                host: 'rabbitmq:5672',
                api: 'rabbitmq:15672',
                protocol: 'http',
                user: 'hyperion',
                pass: 'hyperion',
                vhost: '/hyperion',
                frameMax: '0x10000',
            },
            elasticsearch: {
                protocol: 'http',
                host: 'elasticsearch:9200',
                ingest_nodes: ['elasticsearch:9200'],
                user: '',
                pass: '',
            },
            redis: {
                host: 'redis',
                port: 6379,
            },
            mongodb: {
                enabled: true,
                host: 'mongodb',
                port: 27017,
                database_prefix: 'hyperion',
                user: '',
                pass: '',
            },
            chains: {
                [chainName]: {
                    name: 'Hyperion E2E Test Chain',
                    chain_id: chainId,
                    http: 'http://nodeos:8888',
                    ship: [
                        { label: 'primary', url: 'ws://nodeos:8080' },
                    ],
                    WS_ROUTER_HOST: '0.0.0.0',
                    WS_ROUTER_PORT: wsPort,
                    control_port: controlPort,
                },
            },
            alerts: {
                triggers: {
                    onApiStart: { enabled: false },
                    onIndexerError: { enabled: false },
                },
                providers: {
                    telegram: { enabled: false },
                    http: { enabled: false },
                    email: { enabled: false },
                },
            },
        };

        mkdirSync(this.configDir, { recursive: true });
        const path = join(this.configDir, 'connections.json');
        writeFileSync(path, JSON.stringify(connections, null, 2));

        if (this.config.verbose) {
            console.log(`   📄 Generated ${path}`);
        }

        return path;
    }

    /**
     * Generate the chain-specific config file.
     */
    generateChainConfig(): string {
        const { chainName, liveMode, apiPort } = this.config;

        const chainConfig = {
            api: {
                enabled: true,
                pm2_scaling: 1,
                chain_name: 'Hyperion E2E Test Chain',
                server_addr: '0.0.0.0',
                server_port: apiPort,
                stream_port: (apiPort ?? 17000) + 100,
                stream_scroll_limit: -1,
                stream_scroll_batch: 500,
                server_name: `0.0.0.0:${apiPort}`,
                provider_name: 'E2E Test',
                provider_url: '',
                chain_api: '',
                push_api: '',
                chain_logo_url: '',
                explorer: {
                    home_redirect: false,
                    upstream: '',
                    theme: '',
                },
                enable_caching: true,
                cache_life: 1,
                limits: {
                    get_actions: 1000,
                    get_voters: 100,
                    get_links: 1000,
                    get_deltas: 1000,
                    get_trx_actions: 200,
                },
                access_log: false,
                chain_api_error_log: false,
                log_errors: true,
                custom_core_token: 'TST',
                enable_export_action: true,
                disable_rate_limit: true,
                rate_limit_rpm: 0,
                rate_limit_allow: [],
                disable_tx_cache: false,
                tx_cache_expiration_sec: 3600,
                v1_chain_cache: [
                    { path: 'get_block', ttl: 3000 },
                    { path: 'get_info', ttl: 500 },
                ],
                node_max_old_space_size: 2048,
                node_trace_deprecation: false,
                node_trace_warnings: false,
            },
            indexer: {
                enabled: true,
                start_on: 0,
                stop_on: 0,
                rewrite: false,
                purge_queues: false,
                live_reader: liveMode,
                live_only_mode: false,
                abi_scan_mode: true,
                fetch_block: true,
                fetch_traces: true,
                fetch_deltas: true,
                disable_reading: false,
                disable_indexing: false,
                process_deltas: true,
                node_max_old_space_size: 4096,
                node_trace_deprecation: false,
                node_trace_warnings: false,
            },
            settings: {
                preview: false,
                chain: chainName,
                parser: '3.2',
                auto_stop: liveMode ? 0 : 300,
                index_version: 'v1',
                debug: false,
                bp_logs: false,
                bp_monitoring: false,
                ipc_debug_rate: 60000,
                allow_custom_abi: false,
                rate_monitoring: true,
                max_ws_payload_mb: 256,
                ds_profiling: false,
                auto_mode_switch: true,
                use_global_agent: false,
                index_partition_size: 10000000,
                max_retained_blocks: 0,
                es_replicas: 0,
            },
            blacklists: {
                actions: [],
                deltas: [],
            },
            whitelists: {
                actions: [],
                deltas: [],
                max_depth: 10,
                root_only: false,
            },
            scaling: {
                readers: 1,
                ds_queues: 1,
                ds_threads: 1,
                ds_pool_size: 1,
                indexing_queues: 1,
                ad_idx_queues: 1,
                dyn_idx_queues: 1,
                max_autoscale: 2,
                batch_size: 5000,
                resume_trigger: 5000,
                auto_scale_trigger: 20000,
                block_queue_limit: 10000,
                max_queue_limit: 100000,
                routing_mode: 'round_robin',
                polling_interval: 10000,
            },
            features: {
                streaming: {
                    enable: false,
                    traces: false,
                    deltas: false,
                },
                tables: {
                    proposals: true,
                    accounts: true,
                    voters: true,
                    permissions: true,
                    user_resources: true,
                },
                contract_state: {
                    contracts: {},
                },
                index_deltas: true,
                index_transfer_memo: true,
                index_all_deltas: true,
                deferred_trx: false,
                failed_trx: false,
                resource_limits: false,
                resource_usage: false,
            },
            prefetch: {
                read: 50,
                block: 100,
                index: 500,
            },
            hub: {
                enabled: false,
                instance_key: '',
                custom_indexer_controller: '',
            },
            plugins: {},
            alerts: {
                triggers: {
                    onApiStart: { enabled: false },
                    onIndexerError: { enabled: false },
                },
                providers: {},
            },
        };

        mkdirSync(this.chainsDir, { recursive: true });
        const path = join(this.chainsDir, `${chainName}.config.json`);
        writeFileSync(path, JSON.stringify(chainConfig, null, 2));

        if (this.config.verbose) {
            console.log(`   📄 Generated ${path}`);
        }

        return path;
    }

    /**
     * Generate all configuration files needed for the test run.
     */
    generateConfigs(): IndexerResult {
        console.log('📄 Generating Hyperion configuration (sandboxed)...');

        const connectionsPath = this.generateConnectionsConfig();
        const chainConfigPath = this.generateChainConfig();

        console.log(`   ✅ connections.json → Docker-internal endpoints`);
        console.log(`   ✅ ${this.config.chainName}.config.json → indexer + API config`);
        console.log(`   📂 Config dir: ${this.configDir}`);
        console.log(`   API port: ${this.config.apiPort}`);
        console.log(`   Live mode: ${this.config.liveMode}`);

        return {
            configDir: this.configDir,
            chainsDir: this.chainsDir,
            connectionsPath,
            chainConfigPath,
        };
    }

    // ── Docker Container Lifecycle ────────────────────────────

    /**
     * Start the indexer container.
     */
    startIndexer(): void {
        if (this.config.verbose) console.log('   🐳 Starting hyp-indexer container...');
        execSync(
            'docker compose --profile hyperion up -d hyp-indexer',
            { cwd: this.config.composeDir, stdio: 'pipe' }
        );
    }

    /**
     * Stop and remove the indexer container.
     */
    stopIndexer(): void {
        try {
            execSync(
                'docker compose --profile hyperion stop hyp-indexer 2>/dev/null && docker compose --profile hyperion rm -f hyp-indexer 2>/dev/null',
                { cwd: this.config.composeDir, stdio: 'pipe' }
            );
        } catch { /* best effort */ }
    }

    /**
     * Start the API container.
     */
    startApi(): void {
        if (this.config.verbose) console.log('   🐳 Starting hyp-api container...');
        execSync(
            'docker compose --profile hyperion up -d hyp-api',
            { cwd: this.config.composeDir, stdio: 'pipe' }
        );
    }

    /**
     * Stop and remove the API container.
     */
    stopApi(): void {
        try {
            execSync(
                'docker compose --profile hyperion stop hyp-api 2>/dev/null && docker compose --profile hyperion rm -f hyp-api 2>/dev/null',
                { cwd: this.config.composeDir, stdio: 'pipe' }
            );
        } catch { /* best effort */ }
    }

    /**
     * Check if a container is running.
     */
    isContainerRunning(name: string): boolean {
        try {
            const result = execSync(
                `docker inspect --format='{{.State.Status}}' ${name} 2>/dev/null`,
                { stdio: 'pipe' }
            ).toString().trim();
            return result === 'running';
        } catch {
            return false;
        }
    }

    /**
     * Get container logs (last N lines).
     */
    getContainerLogs(name: string, lines = 20): string {
        try {
            return execSync(
                `docker logs --tail ${lines} ${name} 2>&1`,
                { stdio: 'pipe' }
            ).toString();
        } catch {
            return '';
        }
    }

    // ── Indexing Status ───────────────────────────────────────

    /**
     * Check current ES indexing status via the host-exposed port.
     */
    async getIndexingStatus(): Promise<{
        blocks: number;
        actions: number;
        deltas: number;
    }> {
        const esUrl = this.config.endpoints.esUrl;
        const { chainName } = this.config;
        let blocks = 0, actions = 0, deltas = 0;

        const fetchCount = async (pattern: string): Promise<number> => {
            try {
                const resp = await fetch(`${esUrl}/${pattern}/_count`);
                if (resp.ok) {
                    const data = await resp.json() as any;
                    return data.count ?? 0;
                }
            } catch {}
            return 0;
        };

        [blocks, actions, deltas] = await Promise.all([
            fetchCount(`${chainName}-block-*`),
            fetchCount(`${chainName}-action-*`),
            fetchCount(`${chainName}-delta-*`),
        ]);

        return { blocks, actions, deltas };
    }

    /**
     * Wait for ES indices to reach a target block count.
     */
    async waitForIndexing(targetBlocks: number, timeoutMs = 120000): Promise<boolean> {
        console.log(`⏳ Waiting for indexing to reach block ${targetBlocks}...`);
        const startTime = Date.now();
        let lastBlocks = 0;
        let stalledCount = 0;

        while (Date.now() - startTime < timeoutMs) {
            await new Promise(r => setTimeout(r, 3000));
            const status = await this.getIndexingStatus();
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

            if (this.config.verbose) {
                console.log(`   [${elapsed}s] blocks: ${status.blocks}, actions: ${status.actions}, deltas: ${status.deltas}`);
            }

            if (status.blocks >= targetBlocks) {
                console.log(`   ✅ Indexed ${status.blocks} blocks in ${elapsed}s`);
                return true;
            }

            // Detect stall: no progress (even at 0 — catches immediate crash)
            if (status.blocks === lastBlocks) {
                stalledCount++;
                // After 10s grace period, check container status
                if (stalledCount >= 3) {
                    if (!this.isContainerRunning('hyp-test-indexer')) {
                        const logs = this.getContainerLogs('hyp-test-indexer', 10);
                        console.log(`   ⚠️  Indexer container exited after ${elapsed}s`);
                        if (logs) console.log(logs);
                        return status.blocks >= targetBlocks;
                    }
                }
                if (stalledCount >= 10) {
                    console.log(`   ⚠️  Indexer stalled at block ${status.blocks}`);
                    return false;
                }
            } else {
                stalledCount = 0;
            }
            lastBlocks = status.blocks;
        }

        console.log(`   ⚠️  Indexing timeout after ${timeoutMs / 1000}s`);
        return false;
    }

    /**
     * Clean up sandboxed config files.
     */
    cleanupConfigs(): void {
        const runDir = join(this.config.composeDir, '.run');
        try {
            if (existsSync(runDir)) {
                rmSync(runDir, { recursive: true, force: true });
                console.log('🧹 Cleaned up sandboxed config files');
            }
        } catch {
            console.log('⚠️  Could not clean up .run directory');
        }
    }
}
