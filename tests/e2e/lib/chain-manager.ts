/**
 * ChainManager — Docker Compose orchestrator for the E2E test stack.
 *
 * Manages the lifecycle of the ephemeral infrastructure:
 * nodeos, Elasticsearch (port 9201), RabbitMQ, Redis.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = join(__dirname, '..');
const COMPOSE_FILE = join(E2E_ROOT, 'docker-compose.yml');
const ENV_FILE = join(E2E_ROOT, '.env');

export interface ChainEndpoints {
    nodeosHttp: string;
    nodeosSHiP: string;
    esUrl: string;
    amqpUrl: string;
    redisUrl: string;
}

export interface ChainManagerConfig {
    springVersion?: string;
    cdtVersion?: string;
    esVersion?: string;
    keepContainers?: boolean;
    verbose?: boolean;
}

export class ChainManager {
    private config: Required<ChainManagerConfig>;
    private endpoints: ChainEndpoints;
    private rmqMgmtPort: string;

    constructor(config: ChainManagerConfig = {}) {
        // Load defaults from .env file
        const envDefaults = this.loadEnvFile();

        this.config = {
            springVersion: config.springVersion ?? envDefaults.SPRING_VERSION ?? '1.2.2',
            cdtVersion: config.cdtVersion ?? envDefaults.CDT_VERSION ?? '4.1.1',
            esVersion: config.esVersion ?? envDefaults.ES_VERSION ?? '9.3.1',
            keepContainers: config.keepContainers ?? false,
            verbose: config.verbose ?? false,
        };

        const esPort = envDefaults.ES_PORT ?? '19200';
        const rmqPort = envDefaults.RABBITMQ_PORT ?? '15672';
        const redisPort = envDefaults.REDIS_PORT ?? '16380';
        const nodeosHttpPort = envDefaults.NODEOS_HTTP_PORT ?? '18888';
        const nodeosSHiPPort = envDefaults.NODEOS_SHIP_PORT ?? '18080';
        const rmqUser = envDefaults.RABBITMQ_USER ?? 'hyperion';
        const rmqPass = envDefaults.RABBITMQ_PASS ?? 'hyperion';
        this.rmqMgmtPort = envDefaults.RABBITMQ_MGMT_PORT ?? '25672';

        this.endpoints = {
            nodeosHttp: `http://127.0.0.1:${nodeosHttpPort}`,
            nodeosSHiP: `ws://127.0.0.1:${nodeosSHiPPort}`,
            esUrl: `http://127.0.0.1:${esPort}`,
            amqpUrl: `amqp://${rmqUser}:${rmqPass}@127.0.0.1:${rmqPort}/hyperion`,
            redisUrl: `redis://127.0.0.1:${redisPort}`,
        };
    }

    private loadEnvFile(): Record<string, string> {
        const result: Record<string, string> = {};
        if (existsSync(ENV_FILE)) {
            const lines = readFileSync(ENV_FILE, 'utf-8').split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const [key, ...valueParts] = trimmed.split('=');
                    if (key && valueParts.length > 0) {
                        result[key.trim()] = valueParts.join('=').trim();
                    }
                }
            }
        }
        return result;
    }

    private exec(cmd: string, cwd?: string): string {
        const opts = {
            cwd: cwd ?? E2E_ROOT,
            stdio: this.config.verbose ? 'inherit' as const : 'pipe' as const,
            env: {
                ...process.env,
                SPRING_VERSION: this.config.springVersion,
                CDT_VERSION: this.config.cdtVersion,
                ES_VERSION: this.config.esVersion,
            },
        };
        return execSync(cmd, opts).toString().trim();
    }

    /**
     * Start the Docker Compose stack and wait for all services to be healthy.
     */
    async start(): Promise<ChainEndpoints> {
        console.log('🚀 Starting E2E infrastructure...');
        console.log(`   Spring: v${this.config.springVersion}`);
        console.log(`   CDT: v${this.config.cdtVersion}`);
        console.log(`   ES: v${this.config.esVersion}`);

        // Build and start services
        this.exec(`docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --build`);

        // Wait for all services to become healthy
        console.log('⏳ Waiting for services to become healthy...');
        await this.waitForHealth('nodeos', () => this.checkNodeos());
        await this.waitForHealth('elasticsearch', () => this.checkElasticsearch());
        await this.waitForHealth('rabbitmq', () => this.checkRabbitMQ());
        await this.waitForHealth('redis', () => this.checkRedis());

        console.log('✅ All services healthy!');
        console.log(`   nodeos HTTP: ${this.endpoints.nodeosHttp}`);
        console.log(`   nodeos SHiP: ${this.endpoints.nodeosSHiP}`);
        console.log(`   ES:          ${this.endpoints.esUrl}`);
        console.log(`   RabbitMQ:    ${this.endpoints.amqpUrl}`);
        console.log(`   Redis:       ${this.endpoints.redisUrl}`);

        return this.endpoints;
    }

    /**
     * Stop and clean up the Docker Compose stack.
     */
    async stop(): Promise<void> {
        if (this.config.keepContainers) {
            console.log('🔒 Keeping containers alive (--keep flag)');
            return;
        }
        console.log('🧹 Tearing down E2E infrastructure...');
        this.exec(`docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" down -v`);
        console.log('✅ Infrastructure cleaned up');
    }

    /**
     * Get connection endpoints for Hyperion configuration.
     */
    getEndpoints(): ChainEndpoints {
        return { ...this.endpoints };
    }

    /**
     * Check if nodeos is producing blocks.
     */
    async getChainInfo(): Promise<any> {
        const resp = await fetch(`${this.endpoints.nodeosHttp}/v1/chain/get_info`);
        return resp.json();
    }

    // ── Health Checks ──────────────────────────────────────────

    private async checkNodeos(): Promise<boolean> {
        try {
            const info = await this.getChainInfo();
            return info?.head_block_num > 0;
        } catch {
            return false;
        }
    }

    private async checkElasticsearch(): Promise<boolean> {
        try {
            const resp = await fetch(`${this.endpoints.esUrl}/_cluster/health`);
            const health = await resp.json() as any;
            return health?.status === 'green' || health?.status === 'yellow';
        } catch {
            return false;
        }
    }

    private async checkRabbitMQ(): Promise<boolean> {
        try {
            // Use the management API to check health
            const rmqMgmtPort = this.rmqMgmtPort;
            const resp = await fetch(`http://127.0.0.1:${rmqMgmtPort}/api/health/checks/alarms`, {
                headers: {
                    'Authorization': 'Basic ' + btoa('hyperion:hyperion'),
                },
            });
            return resp.ok;
        } catch {
            return false;
        }
    }

    private async checkRedis(): Promise<boolean> {
        try {
            const port = this.endpoints.redisUrl.split(':').pop();
            // Simple TCP connection check via fetch (Redis doesn't speak HTTP,
            // so we rely on Docker's healthcheck and just verify the port is open)
            const result = this.exec(`docker exec hyp-test-redis redis-cli ping`);
            return result.includes('PONG');
        } catch {
            return false;
        }
    }

    private async waitForHealth(
        service: string,
        check: () => Promise<boolean>,
        maxRetries = 60,
        intervalMs = 2000,
    ): Promise<void> {
        for (let i = 0; i < maxRetries; i++) {
            if (await check()) {
                console.log(`   ✓ ${service} is ready`);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        throw new Error(`❌ ${service} failed to become healthy after ${maxRetries * intervalMs / 1000}s`);
    }
}
