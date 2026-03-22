#!/usr/bin/env bun
/**
 * hyp-test — Hyperion E2E Test CLI
 *
 * Full pipeline:   bun run tests/e2e/hyp-test.ts run
 * Individual:      bun run tests/e2e/hyp-test.ts infra up
 *                  bun run tests/e2e/hyp-test.ts deploy
 *                  bun run tests/e2e/hyp-test.ts index
 *                  bun run tests/e2e/hyp-test.ts verify [--with-api]
 *                  bun run tests/e2e/hyp-test.ts clean
 *
 * NOTE: The E2E suite runs the indexer and API as Docker containers for
 * isolation. This is test-specific — pm2 remains the recommended process
 * manager for production Hyperion deployments.
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { ChainManager } from './lib/chain-manager.js';
import { ContractDeployer } from './lib/contract-deployer.js';
import { LoadGenerator } from './lib/load-generator.js';
import { IndexerRunner } from './lib/indexer-runner.js';
import { IntegrityChecker } from './lib/integrity-checker.js';
import { APITestSuite } from './lib/api-tests.js';
import { ExplorerRunner } from './lib/explorer-runner.js';

const E2E_ROOT = join(import.meta.dirname);
const HYPERION_ROOT = join(E2E_ROOT, '../..');
const REPORTS_DIR = join(E2E_ROOT, 'reports');
const MANIFEST_PATH = join(REPORTS_DIR, 'manifest.json');
const CHAIN_NAME = 'hyp-test';
const EXPLORER_ROOT = join(HYPERION_ROOT, '..', 'hyperion-explorer');
const EXPLORER_PORT = 14210;

const program = new Command();

program
    .name('hyp-test')
    .description('Hyperion E2E Test Suite CLI')
    .version('2.0.0');

// ── SIGINT / SIGTERM Handlers (#4) ───────────────────────────

let cleanupRegistered = false;

function registerCleanupHandler() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;

    const shutdown = (signal: string) => {
        console.log(`\n\n🛑 ${signal} received — cleaning up...`);
        try {
            // Stop Hyperion containers
            execSync(
                'docker compose --profile hyperion stop hyp-indexer hyp-api 2>/dev/null || true',
                { cwd: E2E_ROOT, stdio: 'pipe' }
            );
            execSync(
                'docker compose --profile hyperion rm -f hyp-indexer hyp-api 2>/dev/null || true',
                { cwd: E2E_ROOT, stdio: 'pipe' }
            );
            console.log('   ✅ Hyperion containers stopped');
        } catch {
            // Best effort
        }
        process.exit(130);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ── Helper Functions ─────────────────────────────────────────

function dockerCompose(args: string, opts: { silent?: boolean } = {}) {
    execSync(`docker compose ${args}`, {
        cwd: E2E_ROOT,
        stdio: opts.silent ? 'pipe' : 'inherit',
        timeout: 60000,
    });
}

async function waitForService(url: string, name: string, timeoutSec = 60): Promise<boolean> {
    process.stdout.write(`   ⏳ Waiting for ${name}...`);
    for (let i = 0; i < timeoutSec / 2; i++) {
        try {
            const resp = await fetch(url);
            if (resp.ok) {
                console.log(` ready (${i * 2}s)`);
                return true;
            }
        } catch {}
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log(` timeout after ${timeoutSec}s`);
    return false;
}

function getChainManagerAndEndpoints(): { cm: ChainManager, endpoints: ReturnType<ChainManager['getEndpoints']> } {
    const cm = new ChainManager({ verbose: false });
    return { cm, endpoints: cm.getEndpoints() };
}

function createIndexerRunner(chainId: string, endpoints: any, verbose = false): IndexerRunner {
    return new IndexerRunner({
        chainName: CHAIN_NAME,
        hyperionRoot: HYPERION_ROOT,
        composeDir: E2E_ROOT,
        endpoints,
        chainId,
        liveMode: false,
        verbose,
        apiPort: 17000,
    });
}

function createExplorerRunner(verbose = false): ExplorerRunner {
    return new ExplorerRunner({
        explorerRoot: EXPLORER_ROOT,
        port: EXPLORER_PORT,
        apiUrl: 'http://127.0.0.1:17000',
        verbose,
    });
}

async function runPlaywrightTests(): Promise<{ passed: number; total: number }> {
    const testDir = join(E2E_ROOT, 'explorer-tests');
    try {
        execSync(
            `bunx playwright test --config=${join(testDir, 'playwright.config.ts')}`,
            {
                cwd: testDir,
                stdio: 'inherit',
                timeout: 120_000,
                env: {
                    ...process.env,
                    EXPLORER_URL: `http://127.0.0.1:${EXPLORER_PORT}`,
                    HYP_API_URL: 'http://127.0.0.1:17000',
                },
            }
        );
        const reportPath = join(REPORTS_DIR, 'explorer-test-report.json');
        if (existsSync(reportPath)) {
            const raw = require('fs').readFileSync(reportPath, 'utf8');
            const report = JSON.parse(raw);
            const suites = report.suites || [];
            let passed = 0, total = 0;
            for (const suite of suites) {
                for (const spec of suite.specs || []) {
                    total++;
                    if (spec.ok) passed++;
                }
            }
            return { passed, total };
        }
        return { passed: 1, total: 1 };
    } catch {
        return { passed: 0, total: 1 };
    }
}

// ── infra ────────────────────────────────────────────────────

const infra = program.command('infra').description('Manage Docker infrastructure');

infra.command('up')
    .description('Start Docker infrastructure (nodeos, ES, RabbitMQ, Redis, MongoDB)')
    .action(async () => {
        console.log('🐳 Starting Docker infrastructure...');
        dockerCompose('up -d');
        console.log('\n⏳ Waiting for services...\n');

        const { cm } = getChainManagerAndEndpoints();

        const nodeosReady = await waitForService(
            `http://127.0.0.1:${process.env.NODEOS_HTTP_PORT ?? 18888}/v1/chain/get_info`,
            'nodeos'
        );
        if (!nodeosReady) {
            console.error('❌ nodeos did not become ready');
            process.exit(1);
        }

        const esReady = await waitForService(
            `http://127.0.0.1:${process.env.ES_PORT ?? 19200}/_cluster/health`,
            'Elasticsearch'
        );
        if (!esReady) {
            console.error('❌ Elasticsearch did not become ready');
            process.exit(1);
        }

        const info = await cm.getChainInfo();
        console.log(`\n✅ Infrastructure ready — chain at block ${info.head_block_num}`);
    });

infra.command('down')
    .description('Stop and remove Docker infrastructure')
    .option('--volumes', 'Also remove volumes (deletes all data)')
    .action((opts) => {
        console.log('🛑 Stopping Docker infrastructure...');
        const volumeFlag = opts.volumes ? ' -v' : '';
        dockerCompose(`--profile hyperion down${volumeFlag}`);
        // Clean sandboxed configs
        const runDir = join(E2E_ROOT, '.run');
        if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
        console.log('✅ Infrastructure stopped');
    });

infra.command('status')
    .description('Show Docker service status')
    .action(() => {
        dockerCompose('--profile hyperion ps');
    });

// ── explorer ─────────────────────────────────────────────────

const explorer = program.command('explorer').description('Manage the Hyperion Explorer for E2E testing');

explorer.command('build')
    .description('Build the explorer with e2e configuration (API → port 17000)')
    .action(async () => {
        if (!existsSync(EXPLORER_ROOT)) {
            console.error(`❌ Explorer not found at ${EXPLORER_ROOT}`);
            console.error('   Clone it alongside this repo: git clone https://github.com/eosrio/hyperion-explorer');
            process.exit(1);
        }
        const runner = createExplorerRunner(true);
        runner.install();
        runner.build();
        console.log('\n✅ Explorer built with e2e configuration');
    });

explorer.command('serve')
    .description(`Serve the built explorer on port ${EXPLORER_PORT}`)
    .action(async () => {
        const runner = createExplorerRunner(true);
        await runner.serve();
        console.log(`\n🌐 Explorer running at ${runner.getBaseUrl()}`);
        console.log('   Press Ctrl+C to stop\n');
        // Keep process alive
        await new Promise(() => {});
    });

explorer.command('test')
    .description('Run Playwright smoke tests against a running explorer')
    .action(async () => {
        console.log('🧪 Running explorer smoke tests...\n');
        const results = await runPlaywrightTests();
        console.log(`\n${results.passed === results.total ? '✅' : '❌'} Explorer: ${results.passed}/${results.total} tests passed`);
        process.exit(results.passed === results.total ? 0 : 1);
    });

// ── deploy ───────────────────────────────────────────────────

program.command('deploy')
    .description('Deploy system contracts, create accounts, and generate test load')
    .option('-t, --transfers <n>', 'Number of test transfers', '50')
    .option('-c, --custom-actions <n>', 'Number of custom actions', '20')
    .option('-d, --nested-depth <n>', 'Inline action nesting depth', '3')
    .option('-p, --payload-size <n>', 'Big payload size in bytes', '512')
    .action(async (opts) => {
        console.log('📦 Deploying contracts and generating test load...\n');

        const { cm, endpoints } = getChainManagerAndEndpoints();
        const info = await cm.getChainInfo();
        console.log(`Chain at block ${info.head_block_num}`);

        const deployer = new ContractDeployer(endpoints, { verbose: true });
        const deployResult = await deployer.deploy();
        console.log(`\n✅ Deployed: ${deployResult.accounts.length} accounts, ${deployResult.contracts.length} contracts\n`);

        const loader = new LoadGenerator({
            transfers: parseInt(opts.transfers),
            customActions: parseInt(opts.customActions),
            nestedDepth: parseInt(opts.nestedDepth),
            bigPayloadSize: parseInt(opts.payloadSize),
        }, true);
        const manifest = await loader.generate();
        mkdirSync(REPORTS_DIR, { recursive: true });
        LoadGenerator.saveManifest(manifest, REPORTS_DIR);

        console.log(`\n✅ Load generation complete: ${manifest.summary.totalTransactions} transactions`);
        console.log(`   Manifest saved to reports/manifest.json`);
    });

// ── index ────────────────────────────────────────────────────

program.command('index')
    .description('Run the Hyperion indexer against the test chain')
    .option('--clean', 'Delete existing ES indices before indexing')
    .option('--timeout <seconds>', 'Max time to wait for indexing', '300')
    .action(async (opts) => {
        registerCleanupHandler();
        console.log('📇 Running Hyperion indexer...\n');

        const { cm, endpoints } = getChainManagerAndEndpoints();
        const info = await cm.getChainInfo();
        const esUrl = `http://127.0.0.1:${process.env.ES_PORT ?? 19200}`;

        // Clean existing data if requested
        if (opts.clean) {
            console.log('   🗑️  Cleaning existing indices...');
            try { await fetch(`${esUrl}/${CHAIN_NAME}-*`, { method: 'DELETE' }); } catch {}
        }

        // Generate sandboxed configs and start container
        const runner = createIndexerRunner(info.chain_id, endpoints, true);
        runner.generateConfigs();

        // Stop any previous run
        runner.stopIndexer();

        // Start indexer container
        runner.startIndexer();
        console.log('\n✅ Indexer container started. Monitoring progress...\n');

        // Wait for indexing
        const targetBlocks = info.head_block_num - 2;
        const success = await runner.waitForIndexing(targetBlocks, parseInt(opts.timeout) * 1000);

        // Stop indexer
        runner.stopIndexer();

        // Final status
        const finalStatus = await runner.getIndexingStatus();
        console.log(`\n📊 Final: ${finalStatus.blocks} blocks, ${finalStatus.actions} actions, ${finalStatus.deltas} deltas`);

        if (!success) {
            console.log('⚠️  Indexing may not have completed fully');
        }
    });

// ── verify ───────────────────────────────────────────────────

program.command('verify')
    .description('Run integrity checks and optionally API/explorer tests')
    .option('--with-api', 'Also run API endpoint tests (starts API container)')
    .option('--with-explorer', 'Also run explorer smoke tests')
    .action(async (opts) => {
        registerCleanupHandler();
        console.log('🔍 Running verification suite...\n');

        const esUrl = `http://127.0.0.1:${process.env.ES_PORT ?? 19200}`;
        const apiUrl = `http://127.0.0.1:17000`;

        // Integrity checks
        if (!existsSync(MANIFEST_PATH)) {
            console.error('❌ Manifest not found. Run `hyp-test deploy` first.');
            process.exit(1);
        }

        const checker = new IntegrityChecker({
            esUrl,
            chainName: CHAIN_NAME,
            manifestPath: MANIFEST_PATH,
            verbose: true,
        });
        const integrityReport = await checker.runAll();
        mkdirSync(REPORTS_DIR, { recursive: true });
        writeFileSync(join(REPORTS_DIR, 'integrity-report.json'), JSON.stringify(integrityReport, null, 2));

        // API tests (using Docker container)
        let apiResults: any[] = [];
        if (opts.withApi) {
            console.log('\n━━━ API Tests ━━━\n');

            // Need the runner for API container
            const { cm, endpoints } = getChainManagerAndEndpoints();
            const info = await cm.getChainInfo();
            const runner = createIndexerRunner(info.chain_id, endpoints);

            // Ensure configs exist (may already be generated from index step)
            if (!existsSync(join(E2E_ROOT, '.run', 'config', 'connections.json'))) {
                runner.generateConfigs();
            }

            runner.startApi();
            const apiReady = await waitForService(`${apiUrl}/v2/health`, 'Hyperion API');

            if (apiReady) {
                const suite = new APITestSuite({ apiUrl, chainName: CHAIN_NAME });
                apiResults = await suite.runAll();
                writeFileSync(join(REPORTS_DIR, 'api-test-report.json'), JSON.stringify(apiResults, null, 2));
            } else {
                console.error('❌ API container did not become ready');
                // Print logs for debugging
                const logs = runner.getContainerLogs('hyp-test-api', 20);
                if (logs) console.log(logs);
            }

            runner.stopApi();
        }

        // Explorer tests
        let explorerPassed = 0;
        let explorerTotal = 0;
        if (opts.withExplorer) {
            console.log('\n━━━ Explorer Tests ━━━\n');

            if (!existsSync(EXPLORER_ROOT)) {
                console.error(`❌ Explorer not found at ${EXPLORER_ROOT}`);
                console.error('   Clone it: git clone https://github.com/eosrio/hyperion-explorer ../hyperion-explorer');
            } else {
                const explorer = createExplorerRunner(true);
                explorer.install();
                explorer.build();
                await explorer.serve();

                const results = await runPlaywrightTests();
                explorerPassed = results.passed;
                explorerTotal = results.total;

                explorer.stop();
            }
        }

        // Summary
        const anyFailed = integrityReport.failed > 0 ||
            apiResults.some((r: any) => !r.passed) ||
            (opts.withExplorer && explorerPassed < explorerTotal);

        console.log(`\n${anyFailed ? '❌' : '✅'} Verification ${anyFailed ? 'FAILED' : 'PASSED'}`);
        process.exit(anyFailed ? 1 : 0);
    });

// ── clean ────────────────────────────────────────────────────

program.command('clean')
    .description('Stop all Hyperion containers and optionally tear down infrastructure')
    .option('--all', 'Also stop Docker infrastructure and remove volumes')
    .action((opts) => {
        console.log('🧹 Cleaning up...');

        // Stop Hyperion containers
        try {
            dockerCompose('--profile hyperion stop hyp-indexer hyp-api 2>/dev/null || true', { silent: true });
            dockerCompose('--profile hyperion rm -f hyp-indexer hyp-api 2>/dev/null || true', { silent: true });
        } catch {}
        console.log('   ✅ Hyperion containers stopped');

        // Clean sandboxed configs
        const runDir = join(E2E_ROOT, '.run');
        if (existsSync(runDir)) {
            rmSync(runDir, { recursive: true, force: true });
            console.log('   ✅ Sandboxed configs removed');
        }

        if (opts.all) {
            console.log('   🐳 Stopping Docker infrastructure...');
            dockerCompose('--profile hyperion down -v');
            console.log('   ✅ Docker infrastructure removed');
        }

        console.log('\n✅ Cleanup complete');
    });

// ── run (full pipeline) ──────────────────────────────────────

program.command('run')
    .description('Run the full E2E pipeline: infra → deploy → index → verify')
    .option('-t, --transfers <n>', 'Number of test transfers', '50')
    .option('-c, --custom-actions <n>', 'Number of custom actions', '20')
    .option('--skip-infra', 'Skip Docker infrastructure setup (assume already running)')
    .option('--skip-deploy', 'Skip contract deployment (assume already deployed)')
    .option('--with-api', 'Include API tests in verification')
    .option('--with-explorer', 'Include explorer smoke tests')
    .option('--keep', 'Keep infrastructure running after tests')
    .action(async (opts) => {
        registerCleanupHandler();
        const startTime = Date.now();

        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║             Hyperion E2E — Full Pipeline Run              ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');

        const { cm, endpoints } = getChainManagerAndEndpoints();
        const esUrl = `http://127.0.0.1:${process.env.ES_PORT ?? 19200}`;

        // ── Phase 1: Infrastructure ──────────────────────────
        if (!opts.skipInfra) {
            console.log('━━━ Phase 1: Infrastructure ━━━\n');
            dockerCompose('up -d');

            if (!await waitForService(
                `http://127.0.0.1:${process.env.NODEOS_HTTP_PORT ?? 18888}/v1/chain/get_info`,
                'nodeos'
            )) {
                console.error('❌ nodeos failed to start');
                process.exit(1);
            }

            if (!await waitForService(`${esUrl}/_cluster/health`, 'Elasticsearch')) {
                console.error('❌ Elasticsearch failed to start');
                process.exit(1);
            }
            console.log();
        }

        const info = await cm.getChainInfo();
        console.log(`Chain at block ${info.head_block_num}\n`);

        // ── Phase 2-3: Deploy + Load ─────────────────────────
        if (!opts.skipDeploy) {
            console.log('━━━ Phase 2-3: Deploy & Load ━━━\n');

            const deployer = new ContractDeployer(endpoints, { verbose: true });
            await deployer.deploy();

            const loader = new LoadGenerator({
                transfers: parseInt(opts.transfers),
                customActions: parseInt(opts.customActions),
                nestedDepth: 3,
                bigPayloadSize: 512,
            }, true);
            const manifest = await loader.generate();
            mkdirSync(REPORTS_DIR, { recursive: true });
            LoadGenerator.saveManifest(manifest, REPORTS_DIR);
            console.log(`\n✅ ${manifest.summary.totalTransactions} transactions generated\n`);
        }

        // ── Phase 4: Index ───────────────────────────────────
        console.log('━━━ Phase 4: Index ━━━\n');

        // Clean existing indices
        try { await fetch(`${esUrl}/${CHAIN_NAME}-*`, { method: 'DELETE' }); } catch {}

        const updatedInfo = await cm.getChainInfo();
        const runner = createIndexerRunner(updatedInfo.chain_id, endpoints);
        runner.generateConfigs();

        runner.stopIndexer(); // ensure clean state
        runner.startIndexer();

        // Wait for indexing
        const targetBlocks = updatedInfo.head_block_num - 2;
        let stalledCount = 0;
        let lastBlocks = 0;

        for (let i = 0; i < 100; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const status = await runner.getIndexingStatus();
            process.stdout.write(`\r   Indexing: ${status.blocks}/${targetBlocks} blocks, ${status.actions} actions`);

            if (status.blocks >= targetBlocks) {
                console.log(` ✅`);
                break;
            }

            // Detect stall (including blocks=0 crash)
            if (status.blocks === lastBlocks) {
                stalledCount++;
                if (stalledCount >= 3 && !runner.isContainerRunning('hyp-test-indexer')) {
                    console.log(`\n⚠️  Indexer container crashed`);
                    const logs = runner.getContainerLogs('hyp-test-indexer', 10);
                    if (logs) console.log(logs);
                    break;
                }
                if (stalledCount >= 10) {
                    console.log(` (stalled, continuing)`);
                    break;
                }
            } else {
                stalledCount = 0;
            }
            lastBlocks = status.blocks;
        }

        runner.stopIndexer();

        // ── Phase 5: Verify ──────────────────────────────────
        console.log('\n━━━ Phase 5: Verify ━━━\n');

        const checker = new IntegrityChecker({
            esUrl,
            chainName: CHAIN_NAME,
            manifestPath: MANIFEST_PATH,
            verbose: false,
        });
        const integrityReport = await checker.runAll();
        writeFileSync(join(REPORTS_DIR, 'integrity-report.json'), JSON.stringify(integrityReport, null, 2));

        let apiPassed = 0;
        let apiTotal = 0;

        if (opts.withApi) {
            // Ensure configs exist for the API container
            if (!existsSync(join(E2E_ROOT, '.run', 'config', 'connections.json'))) {
                runner.generateConfigs();
            }
            runner.startApi();
            if (await waitForService('http://127.0.0.1:17000/v2/health', 'Hyperion API')) {
                const suite = new APITestSuite({ apiUrl: 'http://127.0.0.1:17000', chainName: CHAIN_NAME });
                const apiResults = await suite.runAll();
                writeFileSync(join(REPORTS_DIR, 'api-test-report.json'), JSON.stringify(apiResults, null, 2));
                apiPassed = apiResults.filter((r: any) => r.passed).length;
                apiTotal = apiResults.length;
            }
            runner.stopApi();
        }

        // ── Phase 6 (optional): Explorer ─────────────────────
        let explorerPassed = 0;
        let explorerTotal = 0;
        if (opts.withExplorer) {
            console.log('\n━━━ Phase 6: Explorer ━━━\n');

            if (!existsSync(EXPLORER_ROOT)) {
                console.error(`❌ Explorer not found at ${EXPLORER_ROOT}`);
            } else {
                const explorer = createExplorerRunner(true);
                explorer.install();
                explorer.build();
                await explorer.serve();

                const results = await runPlaywrightTests();
                explorerPassed = results.passed;
                explorerTotal = results.total;

                explorer.stop();
            }
        }

        // ── Cleanup ──────────────────────────────────────────
        if (!opts.keep) {
            runner.cleanupConfigs();
        }

        // ── Final Summary ────────────────────────────────────
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║                      FINAL RESULTS                        ║');
        console.log('╠════════════════════════════════════════════════════════════╣');
        console.log(`║  Integrity:  ${integrityReport.passed}/${integrityReport.totalChecks} passed${' '.repeat(41 - `${integrityReport.passed}/${integrityReport.totalChecks}`.length)}║`);
        if (opts.withApi) {
            console.log(`║  API Tests:  ${apiPassed}/${apiTotal} passed${' '.repeat(41 - `${apiPassed}/${apiTotal}`.length)}║`);
        }
        if (opts.withExplorer) {
            console.log(`║  Explorer:   ${explorerPassed}/${explorerTotal} passed${' '.repeat(41 - `${explorerPassed}/${explorerTotal}`.length)}║`);
        }
        console.log(`║  Duration:   ${elapsed}s${' '.repeat(43 - elapsed.length)}║`);
        console.log('╚════════════════════════════════════════════════════════════╝\n');

        const anyFailed = integrityReport.failed > 0 ||
            (opts.withApi && apiPassed < apiTotal) ||
            (opts.withExplorer && explorerPassed < explorerTotal);
        process.exit(anyFailed ? 1 : 0);
    });

program.parse();
