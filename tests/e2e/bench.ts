#!/usr/bin/env bun
/**
 * bench — repeatable profiling driver for performance experiments.
 *
 * Each invocation:
 *   1. stops any running hyp-indexer container
 *   2. wipes block/action/delta indices (keeps ABI index — pre-seeded)
 *   3. regenerates the config with start_on=2 / stop_on=<fixed>
 *      and abi_scan_mode=false (full pipeline)
 *   4. starts the indexer, waits for indexing to complete deterministically,
 *      snapshots the profiling report from the still-running master
 *   5. writes results to reports/bench-<label>.{txt,json}
 *
 * Usage:
 *   bun run tests/e2e/bench.ts <label>
 *
 * The chain is expected to already have hyp-test-abi-v1 seeded (run
 * `bun run tests/e2e/profile-collect.ts abi` once if not).
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ChainManager } from './lib/chain-manager.js';
import { IndexerRunner } from './lib/indexer-runner.js';

const E2E_ROOT = import.meta.dirname;
const HYPERION_ROOT = join(E2E_ROOT, '../..');
const REPORTS_DIR = join(E2E_ROOT, 'reports');
const CHAIN_NAME = 'hyp-test';

// Fixed end-of-workload block. The deploy script lands its transactions
// in the early hundreds of blocks and the chain idles afterwards. Cap
// stop_on here so every bench run processes exactly the same workload
// regardless of how long the chain has idled. Override via env when
// re-benching after a fresh deploy.
const STOP_ON = parseInt(process.env.STOP_ON ?? '2400', 10);
const START_ON = parseInt(process.env.START_ON ?? '2', 10);

const label = process.argv[2];
if (!label) {
    console.error('Usage: bun run tests/e2e/bench.ts <label>');
    process.exit(2);
}

function patchChainConfig(): void {
    const path = join(E2E_ROOT, '.run', 'config', 'chains', `${CHAIN_NAME}.config.json`);
    const c = JSON.parse(readFileSync(path, 'utf8'));
    c.indexer.abi_scan_mode = false;
    c.settings.auto_mode_switch = false;
    c.indexer.start_on = START_ON;
    c.indexer.stop_on = STOP_ON;
    c.settings.auto_stop = 0;

    // Knobs via env vars so we can sweep without recompiling.
    if (process.env.TX_CACHE_MODE) {
        c.api.tx_cache_mode = process.env.TX_CACHE_MODE;
    }
    if (process.env.PREFETCH_BLOCK) {
        c.prefetch.block = parseInt(process.env.PREFETCH_BLOCK, 10);
    }
    if (process.env.PREFETCH_INDEX) {
        c.prefetch.index = parseInt(process.env.PREFETCH_INDEX, 10);
    }
    if (process.env.INDEXING_QUEUES) {
        c.scaling.indexing_queues = parseInt(process.env.INDEXING_QUEUES, 10);
        c.scaling.ad_idx_queues = parseInt(process.env.INDEXING_QUEUES, 10);
        c.scaling.dyn_idx_queues = parseInt(process.env.INDEXING_QUEUES, 10);
    }
    if (process.env.DS_THREADS) {
        c.scaling.ds_threads = parseInt(process.env.DS_THREADS, 10);
    }
    if (process.env.DS_POOL_SIZE) {
        c.scaling.ds_pool_size = parseInt(process.env.DS_POOL_SIZE, 10);
    }
    if (process.env.BATCH_SIZE) {
        c.scaling.batch_size = parseInt(process.env.BATCH_SIZE, 10);
    }
    if (process.env.DISABLE_TX_CACHE === '1' || process.env.DISABLE_TX_CACHE === 'true') {
        c.api.disable_tx_cache = true;
    }

    writeFileSync(path, JSON.stringify(c, null, 2));
    console.log(`   ⚙️  knobs: prefetch.block=${c.prefetch.block}, prefetch.index=${c.prefetch.index}, indexing_queues=${c.scaling.indexing_queues}, ds_threads=${c.scaling.ds_threads}, ds_pool_size=${c.scaling.ds_pool_size}, batch_size=${c.scaling.batch_size}, tx_cache_mode=${c.api.tx_cache_mode ?? 'auto'}`);
}

function snapshot(): string {
    try {
        return execSync(
            `docker exec hyp-test-indexer node /hyperion/build/cli/hyp-control.js stats get-profiling ${CHAIN_NAME}`,
            { stdio: 'pipe', timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }
        ).toString();
    } catch (err: any) {
        return `${err.stdout?.toString() ?? ''}\n--- STDERR ---\n${err.stderr?.toString() ?? ''}\n--- ERR ---\n${err.message}`;
    }
}

async function main() {
    mkdirSync(REPORTS_DIR, { recursive: true });

    const cm = new ChainManager({ verbose: false });
    const endpoints = cm.getEndpoints();
    const info = await cm.getChainInfo();
    console.log(`Chain head: ${info.head_block_num}, bench range: ${START_ON}-${STOP_ON}`);

    const runner = new IndexerRunner({
        chainName: CHAIN_NAME,
        hyperionRoot: HYPERION_ROOT,
        composeDir: E2E_ROOT,
        endpoints,
        chainId: info.chain_id,
        liveMode: false,
        verbose: false,
        apiPort: 17000,
    });

    // Aggressively remove any existing container so logs start fresh.
    // docker compose rm sometimes leaves an Exited container behind, which
    // would cause our log-regex to match the previous run's summary.
    // We use plain `docker rm` (no shell redirects) so Windows cmd.exe
    // doesn't bork on /dev/null.
    try {
        execSync('docker rm -f hyp-test-indexer', { stdio: 'pipe', timeout: 30_000 });
        console.log('   🗑️  removed previous indexer container');
    } catch {}
    runner.stopIndexer();
    runner.generateConfigs();
    patchChainConfig();

    // Delete only block/action/delta — preserve hyp-test-abi-v1 so DS Pool
    // workers can fetch ABIs without re-running an ABI scan pass.
    try {
        await fetch(`http://127.0.0.1:19200/hyp-test-block-*,hyp-test-action-*,hyp-test-delta-*,hyp-test-table-*`, { method: 'DELETE' });
    } catch {}

    // Force-purge stale AMQP queues so old messages don't replay
    try {
        execSync(
            `docker exec hyp-test-rabbitmq bash -lc "rabbitmqctl -p /hyperion list_queues name | grep '^hyp-test:' | xargs -I {} rabbitmqctl -p /hyperion purge_queue {}"`,
            { stdio: 'pipe', timeout: 15_000 }
        );
    } catch { /* best effort */ }

    const startedAt = Date.now();
    console.log(`\n🚀 [${label}] starting indexer...`);
    runner.startIndexer();

    // Continuously snapshot in a tight loop and keep the last GOOD result.
    // No sleep between attempts — `docker exec` itself takes a few hundred
    // ms so the natural pacing is fine.  The master exits ~1s after range
    // completion, so we need to be hammering snapshots before then.
    let summary: string | null = null;
    let profile = '';
    let profileCapturedAt = 0;
    let goodCount = 0;
    let consecutiveBad = 0;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
        const logs = runner.getContainerLogs('hyp-test-indexer', 200);
        const m = logs.match(/Range:\s+\d+\s+>>\s+\d+\s*\n[\s\S]*?Total time:\s+([\d.]+)\s+seconds\s*\n\s*\|\s+Blocks:\s+(\d+)\s*\n\s*\|\s+Actions:\s+(\d+)\s*\n\s*\|\s+Deltas:\s+(\d+)\s*\n\s*\|\s+ABIs:\s+(\d+)/);
        if (m && !summary) {
            summary = `total_sec=${m[1]} blocks=${m[2]} actions=${m[3]} deltas=${m[4]} abis=${m[5]}`;
            process.stdout.write(`\n   ✅ indexer reported: ${summary}\n`);
        }
        const snap = snapshot();
        const isGood = snap.includes('Execution Profiling Report') && /deserializer:\d+\s+process_messages_batch/.test(snap);
        if (isGood) {
            profile = snap;
            profileCapturedAt = Date.now();
            goodCount++;
            consecutiveBad = 0;
            process.stdout.write('+');
        } else {
            consecutiveBad++;
            process.stdout.write('.');
            if (summary && consecutiveBad >= 4) {
                process.stdout.write(`\n   📸 captured ${goodCount} snapshots; last kept.\n`);
                break;
            }
        }
        // Brief pause only if no work to do (pre-summary, no snapshot improvement)
        if (!isGood && !summary) await new Promise(r => setTimeout(r, 250));
    }
    if (!summary) {
        console.log('\n⚠️ indexer summary not detected');
    }
    if (!profile) {
        console.log('\n⚠️ no good profile snapshot captured');
    }

    // Force ES refresh then snapshot final counts (best-effort: ES may have
    // received writes that hadn't been refreshed yet).
    try { await fetch(`http://127.0.0.1:19200/_refresh`, { method: 'POST' }); } catch {}
    const finalStatus = await runner.getIndexingStatus();
    const wallSec = (profileCapturedAt - startedAt) / 1000 || (Date.now() - startedAt) / 1000;
    console.log(`📊 ES final → blocks=${finalStatus.blocks}, actions=${finalStatus.actions}, deltas=${finalStatus.deltas}; wall=${wallSec.toFixed(2)}s`);

    let containerStats = '';
    try {
        containerStats = execSync(
            `docker stats --no-stream --format "CPU={{.CPUPerc}} MEM={{.MemUsage}}" hyp-test-indexer`,
            { stdio: 'pipe', timeout: 10_000 }
        ).toString().trim();
    } catch {}

    const result = {
        label,
        timestamp: new Date(startedAt).toISOString(),
        indexerSummary: summary,
        finalCounts: finalStatus,
        wallSec,
        containerStats,
        profile,
    };
    writeFileSync(join(REPORTS_DIR, `bench-${label}.json`), JSON.stringify(result, null, 2));
    writeFileSync(join(REPORTS_DIR, `bench-${label}.txt`), profile);
    writeFileSync(join(REPORTS_DIR, `bench-${label}.log`), runner.getContainerLogs('hyp-test-indexer', 200));

    console.log('\n────────── PROFILE ──────────');
    console.log(profile);
    console.log('─────────────────────────────');
    console.log(`📁 reports/bench-${label}.{txt,json,log}`);
    console.log(`📊 ${containerStats}`);

    runner.stopIndexer();
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
