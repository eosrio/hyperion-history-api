#!/usr/bin/env bun
/**
 * profile-collect — drive a profiling pass and snapshot the report from
 * the still-running indexer master. Writes results to
 * reports/profiling-report-<phase>.{json,txt}.
 *
 * Usage:
 *   bun run tests/e2e/profile-collect.ts <phase>
 *     phase=abi   → abi_scan_mode=true   (profile the ABI scan pipeline)
 *     phase=full  → abi_scan_mode=false  (profile the full pipeline incl traces)
 *
 * Assumes infrastructure (`hyp-test infra up`) and `hyp-test deploy` have
 * already run, and that the hyp-indexer docker image is built.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ChainManager } from './lib/chain-manager.js';
import { IndexerRunner } from './lib/indexer-runner.js';

const E2E_ROOT = import.meta.dirname;
const HYPERION_ROOT = join(E2E_ROOT, '../..');
const REPORTS_DIR = join(E2E_ROOT, 'reports');
const CHAIN_NAME = 'hyp-test';

const phase = (process.argv[2] ?? 'full').toLowerCase();
if (!['abi', 'full'].includes(phase)) {
    console.error(`Unknown phase '${phase}'. Use abi|full.`);
    process.exit(2);
}

// Patch generated config to flip abi_scan_mode based on phase.
function patchChainConfig(): void {
    const path = join(E2E_ROOT, '.run', 'config', 'chains', `${CHAIN_NAME}.config.json`);
    const c = JSON.parse(readFileSync(path, 'utf8'));
    c.indexer.abi_scan_mode = (phase === 'abi');
    c.settings.auto_mode_switch = (phase === 'abi'); // only auto-switch on abi pass
    writeFileSync(path, JSON.stringify(c, null, 2));
    console.log(`   ⚙️  abi_scan_mode=${c.indexer.abi_scan_mode}, auto_mode_switch=${c.settings.auto_mode_switch}`);
}

async function snapshotProfiling(label: string): Promise<{ text: string; json: any }> {
    let text = '';
    try {
        text = execSync(
            `docker exec hyp-test-indexer node /hyperion/build/cli/hyp-control.js stats get-profiling ${CHAIN_NAME}`,
            { stdio: 'pipe', timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }
        ).toString();
    } catch (err: any) {
        text = `${err.stdout?.toString() ?? ''}\n--- STDERR ---\n${err.stderr?.toString() ?? ''}\n--- ERR ---\n${err.message}`;
    }
    return { text, json: null };
}

async function main() {
    mkdirSync(REPORTS_DIR, { recursive: true });

    const cm = new ChainManager({ verbose: false });
    const endpoints = cm.getEndpoints();
    const info = await cm.getChainInfo();
    console.log(`\nChain head: ${info.head_block_num} (chain_id=${info.chain_id.slice(0, 12)}…)`);
    console.log(`Profiling phase: ${phase.toUpperCase()}\n`);

    const runner = new IndexerRunner({
        chainName: CHAIN_NAME,
        hyperionRoot: HYPERION_ROOT,
        composeDir: E2E_ROOT,
        endpoints,
        chainId: info.chain_id,
        liveMode: false,
        verbose: true,
        apiPort: 17000,
    });
    runner.generateConfigs();
    patchChainConfig();

    // Make sure no leftover indexer container is hanging around
    runner.stopIndexer();

    const startedAt = Date.now();
    console.log('\n🚀 Starting hyp-indexer container...');
    runner.startIndexer();
    console.log('   ⏳ Grace 20s for SHIP connect + worker bootstrap...');
    await new Promise(r => setTimeout(r, 20_000));

    const targetBlocks = info.head_block_num - 2;
    let lastActions = -1;
    let lastDeltas = -1;
    let idleCount = 0;

    for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const status = await runner.getIndexingStatus();
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        process.stdout.write(`\r   [${elapsed}s] blocks: ${status.blocks}/${targetBlocks}, actions: ${status.actions}, deltas: ${status.deltas}      `);

        // Consider the indexer "settled" when blocks counter is at/near target
        // AND counters stop changing for a few polls.
        const settled = (status.blocks >= targetBlocks - 5)
            && status.actions === lastActions
            && status.deltas === lastDeltas;

        if (settled) idleCount++;
        else idleCount = 0;

        if (idleCount >= 3) {
            process.stdout.write('\n   ✅ Indexer reached steady state.\n');
            break;
        }

        lastActions = status.actions;
        lastDeltas = status.deltas;
    }

    // Force ES refresh and get final counts
    try { await fetch(`http://127.0.0.1:${process.env.ES_PORT ?? 19200}/_refresh`, { method: 'POST' }); } catch {}
    const finalStatus = await runner.getIndexingStatus();
    const totalRunSec = (Date.now() - startedAt) / 1000;
    console.log(`\n⏱️  Total wall time: ~${totalRunSec.toFixed(1)}s`);
    console.log(`📊 Final ES counts → blocks: ${finalStatus.blocks}, actions: ${finalStatus.actions}, deltas: ${finalStatus.deltas}`);

    console.log('\n🔬 Capturing profiling report...');
    const snap = await snapshotProfiling('final');

    // Container resource snapshot
    let containerStats = '';
    try {
        containerStats = execSync(
            `docker stats --no-stream --format "{{.Name}} CPU={{.CPUPerc}} MEM={{.MemUsage}}" hyp-test-indexer`,
            { stdio: 'pipe', timeout: 10_000 }
        ).toString().trim();
    } catch {}

    const tailLogs = runner.getContainerLogs('hyp-test-indexer', 100);

    const outBase = `profiling-${phase}`;
    const outJson = {
        chain: CHAIN_NAME,
        chainId: info.chain_id,
        phase,
        startedAt: new Date(startedAt).toISOString(),
        runDurationSec: totalRunSec,
        finalCounts: finalStatus,
        containerStats,
        profilingTextReport: snap.text,
    };
    writeFileSync(join(REPORTS_DIR, `${outBase}.json`), JSON.stringify(outJson, null, 2));
    writeFileSync(join(REPORTS_DIR, `${outBase}.txt`), snap.text);
    writeFileSync(join(REPORTS_DIR, `${outBase}.log`), tailLogs);

    console.log('\n────────── PROFILING REPORT ──────────');
    console.log(snap.text);
    console.log('──────────────────────────────────────\n');
    console.log(`📁 ${join(REPORTS_DIR, `${outBase}.json`)}`);
    console.log(`📁 ${join(REPORTS_DIR, `${outBase}.txt`)}`);
    console.log(`📁 ${join(REPORTS_DIR, `${outBase}.log`)}`);
    console.log(`📁 container stats → ${containerStats}`);

    console.log('\n🛑 Stopping indexer...');
    runner.stopIndexer();
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
