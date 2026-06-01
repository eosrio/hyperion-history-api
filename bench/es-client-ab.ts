/**
 * es-client-ab.ts — A/B benchmark isolating the @elastic/elasticsearch client variable.
 *
 * Goal: measure ES `_bulk` write throughput of the SAME client library under two transports:
 *   - node  -> default UndiciConnection (today's indexer transport)
 *   - bun   -> HttpConnection (node:http), selected automatically by esConnectionOptions()
 *
 * It does NOT touch the SHIP->deserialize pipeline; it only generates synthetic, Hyperion-shaped
 * ACTION docs and bulk-indexes them, so the only moving part between runtimes is the ES client.
 *
 * SAFETY: refuses any non-loopback ES host unless BENCH_ALLOW_EXTERNAL_ES=1 (do not set that).
 *
 * Run:
 *   node bench/es-client-ab.ts
 *   bun  bench/es-client-ab.ts
 *
 * Env knobs (defaults in []):
 *   ES_NODE     [http://127.0.0.1:9200]  bench ES endpoint (must be loopback)
 *   BENCH_DOCS  [1000000]                total docs to index
 *   BENCH_BATCH [4000]                   docs per _bulk request
 *   BENCH_INFLIGHT [4]                   concurrent in-flight _bulk requests
 *   BENCH_INDEX [bench-action-ab]        index name (dropped + recreated each run)
 *   ES_HTTP_CONNECTION  forces transport on(1)/off(0); otherwise auto (bun=http, node=undici)
 */

import {Client} from '@elastic/elasticsearch';
import {esConnectionOptions} from '../src/indexer/helpers/es-connection.ts';

// ----------------------------------------------------------------------------- config
const ES_NODE = process.env.ES_NODE || 'http://127.0.0.1:9200';
const TOTAL_DOCS = parseInt(process.env.BENCH_DOCS || '1000000', 10);
const BATCH = parseInt(process.env.BENCH_BATCH || '4000', 10);
const INFLIGHT = parseInt(process.env.BENCH_INFLIGHT || '4', 10);
const INDEX = process.env.BENCH_INDEX || 'bench-action-ab';

const runtime = typeof (process as any).versions.bun === 'string'
    ? `bun ${(process as any).versions.bun}`
    : `node ${process.versions.node}`;

// ----------------------------------------------------------------------------- safety guard
function assertLoopback(node: string) {
    if (process.env.BENCH_ALLOW_EXTERNAL_ES === '1') {
        console.warn('[WARN] BENCH_ALLOW_EXTERNAL_ES=1 — loopback guard disabled');
        return;
    }
    let host: string;
    try {
        host = new URL(node).hostname;
    } catch {
        throw new Error(`Cannot parse ES_NODE: ${node}`);
    }
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    if (!loopback) {
        throw new Error(
            `Refusing to benchmark non-loopback ES host "${host}". This bench writes/drops indices ` +
            `and is LOCAL-ONLY. Set BENCH_ALLOW_EXTERNAL_ES=1 to override (NOT recommended).`
        );
    }
}

// ----------------------------------------------------------------------------- synthetic docs
// Representative Hyperion ACTION doc (~200-400 bytes JSON). Shapes mirror action.json mapping.
const ACCOUNTS = ['eosio.token', 'eosio', 'eosio.stake', 'eosio.rex', 'atomicassets', 'newdexpublic'];
const NAMES = ['transfer', 'issue', 'newaccount', 'delegatebw', 'voteproducer', 'buyram'];
const ACTORS = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd', 'eeeeeeeeeeee'];

function makeDoc(seq: number): Record<string, unknown> {
    const acct = ACCOUNTS[seq % ACCOUNTS.length];
    const name = NAMES[seq % NAMES.length];
    const actor = ACTORS[seq % ACTORS.length];
    const recv = ACTORS[(seq + 1) % ACTORS.length];
    const block = 100000000 + Math.floor(seq / 12);
    // Compact Hyperion-shaped action doc; JSON body ~300-400 B to match the spec's target size.
    return {
        '@timestamp': new Date(1600000000000 + seq * 500).toISOString(),
        global_sequence: 20000000000 + seq,
        block_num: block,
        trx_id: (seq.toString(16).padStart(8, '0') + 'a'.repeat(56)),
        action_ordinal: 1 + (seq % 8),
        cpu_usage_us: 100 + (seq % 400),
        net_usage_words: 12 + (seq % 16),
        producer: ACCOUNTS[(seq + 2) % ACCOUNTS.length],
        act: {
            account: acct,
            name,
            authorization: [{actor, permission: 'active'}],
            data: {
                from: actor,
                to: recv,
                quantity: `${(seq % 100000) / 10000}.0000 EOS`,
                memo: `bench ${seq}`
            }
        },
        notified: [acct, recv]
    };
}

// Measure on-the-wire bytes of one bulk line pair to compute MB/s accurately.
function bulkLineBytes(doc: Record<string, unknown>, id: string): number {
    const meta = JSON.stringify({index: {_index: INDEX, _id: id}}) + '\n';
    const body = JSON.stringify(doc) + '\n';
    return Buffer.byteLength(meta, 'utf8') + Buffer.byteLength(body, 'utf8');
}

// ----------------------------------------------------------------------------- ES setup
async function recreateIndex(client: Client) {
    if (await client.indices.exists({index: INDEX})) {
        await client.indices.delete({index: INDEX});
    }
    await client.indices.create({
        index: INDEX,
        settings: {
            number_of_shards: 4,
            number_of_replicas: 0,
            refresh_interval: '-1',
            'sort.field': 'global_sequence',
            'sort.order': 'desc'
        },
        mappings: {
            properties: {
                '@timestamp': {type: 'date'},
                global_sequence: {type: 'long'},
                block_num: {type: 'long'},
                block_id: {type: 'keyword'},
                trx_id: {type: 'keyword', doc_values: false},
                action_ordinal: {type: 'long'},
                creator_action_ordinal: {type: 'long'},
                cpu_usage_us: {type: 'integer'},
                net_usage_words: {type: 'integer'},
                code_sequence: {type: 'integer'},
                abi_sequence: {type: 'integer'},
                producer: {type: 'keyword'},
                'act.account': {type: 'keyword'},
                'act.name': {type: 'keyword'},
                'act.authorization.actor': {type: 'keyword'},
                'act.authorization.permission': {enabled: false},
                'act.data': {enabled: false},
                notified: {type: 'keyword'}
            }
        }
    });
}

// ----------------------------------------------------------------------------- stats helpers
function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

// ----------------------------------------------------------------------------- bench core
async function run() {
    assertLoopback(ES_NODE);

    const opts = esConnectionOptions();
    const usingHttp = 'Connection' in opts;

    const client = new Client({
        node: ES_NODE,
        requestTimeout: 120000,
        ...opts
    });

    console.log('='.repeat(72));
    console.log(`ES client A/B bench`);
    console.log(`  runtime    : ${runtime}`);
    console.log(`  transport  : ${usingHttp ? 'HttpConnection (node:http)' : 'UndiciConnection (default)'}`);
    console.log(`  ES node    : ${ES_NODE}`);
    console.log(`  docs       : ${TOTAL_DOCS.toLocaleString()}`);
    console.log(`  batch      : ${BATCH}  inflight: ${INFLIGHT}`);
    console.log(`  index      : ${INDEX}`);
    console.log('='.repeat(72));

    const esVer = await client.info();
    console.log(`  ES version : ${esVer.version.number}`);

    await recreateIndex(client);

    // measure approx bytes/doc on a sample
    let sampleBytes = 0;
    for (let i = 0; i < 100; i++) sampleBytes += bulkLineBytes(makeDoc(i), `id-${i}`);
    const avgBytesPerDoc = sampleBytes / 100;

    const latencies: number[] = [];
    let bulkErrors = 0;
    let itemErrors = 0;
    let docsSent = 0;
    let bytesSent = 0;
    let peakRss = process.memoryUsage().rss;

    const sampleRss = () => {
        const r = process.memoryUsage().rss;
        if (r > peakRss) peakRss = r;
    };
    const rssTimer = setInterval(sampleRss, 200);

    // Build a single bulk operations payload (NDJSON array form accepted by client.bulk).
    function buildBatch(startSeq: number, count: number): Array<Record<string, unknown>> {
        const ops: Array<Record<string, unknown>> = [];
        for (let i = 0; i < count; i++) {
            const seq = startSeq + i;
            ops.push({index: {_index: INDEX, _id: `a-${seq}`}});
            ops.push(makeDoc(seq));
        }
        return ops;
    }

    async function sendBatch(startSeq: number, count: number) {
        const ops = buildBatch(startSeq, count);
        const t0 = performance.now();
        try {
            const res = await client.bulk({operations: ops});
            const dt = performance.now() - t0;
            latencies.push(dt);
            if (res.errors) {
                for (const item of res.items) {
                    const op = item.index || item.create || item.update || item.delete;
                    if (op && op.error) itemErrors++;
                }
            }
        } catch (e: any) {
            bulkErrors++;
            const dt = performance.now() - t0;
            latencies.push(dt);
            if (bulkErrors <= 3) console.error(`  [bulk error] ${e?.message || e}`);
        }
        docsSent += count;
        bytesSent += count * avgBytesPerDoc;
    }

    // Concurrency: a sliding window of INFLIGHT in-flight bulk requests.
    const tStart = performance.now();
    let nextSeq = 0;
    const inFlight = new Set<Promise<void>>();

    while (nextSeq < TOTAL_DOCS) {
        const count = Math.min(BATCH, TOTAL_DOCS - nextSeq);
        const seq = nextSeq;
        nextSeq += count;
        const p = sendBatch(seq, count).then(() => {
            inFlight.delete(p);
        });
        inFlight.add(p);
        if (inFlight.size >= INFLIGHT) {
            await Promise.race(inFlight);
        }
    }
    await Promise.all(inFlight);
    const tEnd = performance.now();
    clearInterval(rssTimer);
    sampleRss();

    const wallSec = (tEnd - tStart) / 1000;
    const docsPerSec = docsSent / wallSec;
    const mbSent = bytesSent / (1024 * 1024);
    const mbPerSec = mbSent / wallSec;
    latencies.sort((a, b) => a - b);
    const mean = latencies.reduce((s, x) => s + x, 0) / latencies.length;

    // Confirm doc count landed in ES.
    await client.indices.refresh({index: INDEX});
    const countRes = await client.count({index: INDEX});

    console.log('-'.repeat(72));
    console.log(`RESULTS [${runtime} / ${usingHttp ? 'HttpConnection' : 'UndiciConnection'}]`);
    console.log(`  total time      : ${wallSec.toFixed(2)} s`);
    console.log(`  docs indexed    : ${docsSent.toLocaleString()} (ES count: ${countRes.count.toLocaleString()})`);
    console.log(`  avg bytes/doc   : ${avgBytesPerDoc.toFixed(0)} B (bulk line pair)`);
    console.log(`  throughput      : ${docsPerSec.toFixed(0)} docs/s`);
    console.log(`  bandwidth       : ${mbPerSec.toFixed(1)} MB/s  (${mbSent.toFixed(0)} MB total)`);
    console.log(`  bulk latency    : mean ${mean.toFixed(1)} ms | p50 ${percentile(latencies, 50).toFixed(1)} ms | p95 ${percentile(latencies, 95).toFixed(1)} ms | p99 ${percentile(latencies, 99).toFixed(1)} ms | max ${latencies[latencies.length - 1].toFixed(1)} ms`);
    console.log(`  peak RSS        : ${(peakRss / (1024 * 1024)).toFixed(0)} MB`);
    console.log(`  bulk req errors : ${bulkErrors}`);
    console.log(`  per-item errors : ${itemErrors}`);
    console.log('-'.repeat(72));

    // Machine-readable line for easy diffing across runs.
    console.log('JSON ' + JSON.stringify({
        runtime,
        transport: usingHttp ? 'HttpConnection' : 'UndiciConnection',
        docs: docsSent,
        es_count: countRes.count,
        wall_s: +wallSec.toFixed(2),
        docs_per_s: Math.round(docsPerSec),
        mb_per_s: +mbPerSec.toFixed(1),
        peak_rss_mb: Math.round(peakRss / (1024 * 1024)),
        lat_mean_ms: +mean.toFixed(1),
        lat_p50_ms: +percentile(latencies, 50).toFixed(1),
        lat_p95_ms: +percentile(latencies, 95).toFixed(1),
        lat_p99_ms: +percentile(latencies, 99).toFixed(1),
        bulk_errors: bulkErrors,
        item_errors: itemErrors
    }));

    await client.close();
}

run().catch((e) => {
    console.error('BENCH FAILED:', e);
    process.exit(1);
});
