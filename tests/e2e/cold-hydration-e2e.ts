/**
 * Cold-tier archive hydration — END-TO-END proof against REAL route code.
 * ----------------------------------------------------------------------
 * Stands up a bare Fastify instance, decorates it with exactly what the v2
 * get_actions / get_deltas route plugins need, registers the REAL compiled
 * route plugins, and drives them with fastify.inject(). The route handler runs
 * the genuine code path:
 *
 *   timedQuery -> getActions/getDeltas -> fastify.elastic.search (real cold ES)
 *              -> hydrateActions/hydrateDeltas (real archive POST) -> mergeMeta
 *
 * Nothing about the route is stubbed. Only the *environment* is decorated:
 *   - fastify.elastic   : real @elastic/elasticsearch Client -> :9200 (cold)
 *   - fastify.manager   : { chain:'wax', config:{ api:{ ..., archives:{...} } } }
 *   - fastify.redis     : tiny no-op stub so timedQuery's cache path is inert
 *                         (the goal is the QUERY path, not caching)
 *   - fastify.antelope  : stub (only used by ?checkLib, which we don't set)
 *   - allowedActionQueryParamSet : built exactly like server.ts does
 *
 * Windows note: the route's index.ts derives its URL from getRouteName(
 * import.meta.filename).split('/') — which yields a backslash path on Windows.
 * So instead of guessing the URL, we capture the URL the plugin actually
 * registers via an onRoute hook and inject to that exact URL.
 *
 * Run:  npx tsc && node build/tests/e2e/cold-hydration-e2e.js
 */

import Fastify, { FastifyInstance } from 'fastify';
import { Client } from '@elastic/elasticsearch';
import { createInterface } from 'node:readline';
import { createReadStream, accessSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// Import the REAL, COMPILED route code emitted by `npx tsc` into build/.
// tests/ is excluded from the main tsconfig (and outside rootDir), so this
// harness is compiled separately (tsconfig.harness.json) and run with plain
// node against the compiled route JS in build/ — the genuine route code path,
// exactly what production serves. The build dir is resolved from the REPO ROOT
// at runtime so it works regardless of where this harness JS is emitted.
const __dir = dirname(fileURLToPath(import.meta.url));
// Walk up to the repo root (the dir that contains build/). This harness lives
// at <root>/tests/e2e[/dist]; resolve up until build/ is found.
function findBuildApi(): string {
    let d = __dir;
    for (let i = 0; i < 6; i++) {
        const candidate = resolve(d, 'build', 'api');
        try {
            accessSync(candidate);
            return candidate;
        } catch { /* keep walking up */ }
        d = resolve(d, '..');
    }
    throw new Error('could not locate build/api from ' + __dir);
}
const BUILD_API = findBuildApi();
const imp = (rel: string) => import(pathToFileURL(resolve(BUILD_API, rel)).href);

const { extendedActions } = await imp('routes/v2-history/get_actions/definitions.js');
const getActionsPlugin = (await imp('routes/v2-history/get_actions/index.js')).default;
const getDeltasPlugin = (await imp('routes/v2-history/get_deltas/index.js')).default;

const ES_URL = 'http://localhost:9200';
const ARCHIVE_URL = 'http://localhost:8088';
const ACTION_INDEX = 'wax-action-v1-000020';
const DELTA_INDEX = 'wax-delta-v1-000020';
const HOT_ACTIONS_NDJSON = 'C:/Users/igorl/AppData/Local/Temp/wax-real-actions.ndjson';
const HOT_DELTAS_NDJSON = 'C:/Users/igorl/AppData/Local/Temp/hot-deltas.ndjson';

// ----- tiny assertion plumbing ------------------------------------------------
let PASS = 0;
let FAIL = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
    if (cond) {
        PASS++;
        console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
    } else {
        FAIL++;
        failures.push(name + (detail ? ' — ' + detail : ''));
        console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
    }
}
function section(t: string) {
    console.log('\n========== ' + t + ' ==========');
}

// deep-equal good enough for plain JSON (objects/arrays/scalars)
function deepEq(a: any, b: any): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === 'object') {
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (const k of ka) {
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!deepEq(a[k], b[k])) return false;
        }
        return true;
    }
    return false;
}

// ----- build the bare Fastify instance with real route plugins ----------------
function buildConfig() {
    return {
        chain: 'wax',
        config: {
            api: {
                limits: { get_actions: 1000, get_deltas: 1000 },
                query_timeout: '10s',
                max_asc_window_days: 90,
                enable_caching: false,
                archives: {
                    enabled: true,
                    timeout_ms: 5000,
                    max_batch: 20000,
                    actions: [{ url: ARCHIVE_URL, first_block: 1, last_block: 200000000 }],
                    deltas: [{ url: ARCHIVE_URL, first_block: 1, last_block: 200000000 }]
                }
            }
        }
    };
}

async function buildServer(): Promise<{ fastify: FastifyInstance; urls: Record<string, string> }> {
    const fastify = Fastify({
        ajv: { customOptions: { strict: false, allowUnionTypes: true } }
    });

    // Decorations the routes read.
    fastify.decorate('elastic', new Client({ node: ES_URL }) as any);
    fastify.decorate('manager', buildConfig() as any);
    // built exactly like server.ts (extendedActions seed; no module loader here)
    fastify.decorate('allowedActionQueryParamSet', new Set<string>([...extendedActions]) as any);
    // antelope only used by ?checkLib (not exercised); stub for safety.
    fastify.decorate('antelope', {
        chain: { get_info: async () => ({ last_irreversible_block_num: 0 }) }
    } as any);
    // redis: timedQuery calls fastify.redis.get(...). caching disabled, so a
    // get() that returns null makes the whole cache path an inert no-op.
    fastify.decorate('redis', {
        get: async () => null,
        set: async () => 'OK'
    } as any);

    // Capture the URLs the real plugins register.
    //
    // Windows quirk: index.ts derives its route name from
    //   getRouteName(import.meta.filename) -> filename.split('/') -> single
    //   backslash path -> arr[len-2] === undefined
    // so BOTH plugins try to register the literal URL '<prefix>/undefined'.
    // We therefore give each plugin its OWN distinct prefix so they don't
    // collide, and capture whatever URL each actually registered via onRoute.
    // The handler/schema/timedQuery/getActions/hydrate code path is unchanged —
    // only the URL string differs, which is irrelevant to what we're proving.
    const urls: Record<string, string> = {};
    const seen: { url: string; prefix: string }[] = [];
    fastify.addHook('onRoute', (r) => {
        if (typeof r.url === 'string' && r.method === 'GET') {
            seen.push({ url: r.url, prefix: (r as any).prefix ?? '' });
        }
    });

    // Register the REAL route plugins, each in its own encapsulated prefix.
    await fastify.register(async (scope) => {
        await scope.register(getActionsPlugin as any);
    }, { prefix: '/actions-route' });
    await fastify.register(async (scope) => {
        await scope.register(getDeltasPlugin as any);
    }, { prefix: '/deltas-route' });
    await fastify.ready();

    for (const s of seen) {
        if (s.url.includes('/actions-route')) urls.actions = s.url;
        if (s.url.includes('/deltas-route')) urls.deltas = s.url;
    }
    return { fastify, urls };
}

// ----- hot reference loaders --------------------------------------------------
async function loadHotActions(gsSet: Set<string>): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    if (gsSet.size === 0) return map;
    await new Promise<void>((resolve) => {
        const rl = createInterface({ input: createReadStream(HOT_ACTIONS_NDJSON) });
        rl.on('line', (line) => {
            if (!line) return;
            // cheap pre-filter before JSON.parse
            let hit = false;
            for (const gs of gsSet) { if (line.includes(gs)) { hit = true; break; } }
            if (!hit) return;
            try {
                const d = JSON.parse(line);
                const gs = String(d.global_sequence);
                if (gsSet.has(gs)) map.set(gs, d);
            } catch { /* ignore */ }
        });
        rl.on('close', resolve);
    });
    return map;
}

async function loadHotDeltas(keySet: Set<string>): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    if (keySet.size === 0) return map;
    await new Promise<void>((resolve) => {
        const rl = createInterface({ input: createReadStream(HOT_DELTAS_NDJSON) });
        rl.on('line', (line) => {
            if (!line) return;
            try {
                const d = JSON.parse(line);
                const k = `${d.block_num}|${d.code}|${d.scope}|${d.table}|${d.primary_key}`;
                if (keySet.has(k)) map.set(k, d);
            } catch { /* ignore */ }
        });
        rl.on('close', resolve);
    });
    return map;
}

// Reproduce the route's @-merge so we can compute the expected HOT response
// act.data from a raw hot _source (mergeActionMeta merges @<name> into act.data).
function hotExpectedActData(hotDoc: any): any {
    const name = hotDoc.act?.name;
    const base = hotDoc.act?.data ?? {};
    const ext = hotDoc['@' + name];
    if (ext) {
        // _.merge(ext, base) — base wins on key conflicts, like the route does.
        return { ...ext, ...base };
    }
    return base;
}

function hotExpectedDeltaData(hotDoc: any): { data?: any; value?: any } {
    // mergeDeltaMeta merges @<table> into data; deltas in this range carry no
    // @<table> ext, so data/value pass through unchanged.
    const name = hotDoc.table;
    const ext = hotDoc['@' + name];
    let data = hotDoc.data;
    if (ext) data = { ...ext, ...(hotDoc.data ?? {}) };
    return { data, value: hotDoc.value };
}

// ----- raw cold-ES helpers (independent of the route) -------------------------
async function rawColdActionByGs(client: Client, gs: string): Promise<any | null> {
    const r = await client.search<any>({
        index: ACTION_INDEX, size: 1,
        query: { term: { global_sequence: gs } }
    });
    return r.hits.hits[0]?._source ?? null;
}

// ============================================================================
async function main() {
    console.log('Cold-tier archive hydration — END-TO-END via REAL route plugins (fastify.inject)\n');
    const client = new Client({ node: ES_URL });

    const { fastify, urls } = await buildServer();
    console.log('Registered route URLs:', JSON.stringify(urls));
    check('get_actions route registered', !!urls.actions, urls.actions);
    check('get_deltas route registered', !!urls.deltas, urls.deltas);

    // ---------------------------------------------------------------------
    // TEST 5 (run first): cold ES docs genuinely lack act.data BEFORE hydration
    // ---------------------------------------------------------------------
    section('PRE-CHECK: cold ES docs lack act.data (so the archive is the source)');
    {
        const r = await client.search<any>({
            index: ACTION_INDEX, size: 200,
            query: { bool: { should: [
                { term: { notified: 'alien.worlds' } },
                { term: { 'act.authorization.actor': 'alien.worlds' } }
            ] } },
            sort: [{ global_sequence: 'asc' }]
        });
        const hits = r.hits.hits;
        const withData = hits.filter((h: any) => h._source?.act?.data !== undefined).length;
        check('cold ES action sample has NO act.data', withData === 0,
            `${hits.length} cold docs scanned, ${withData} carry act.data`);
        if (hits[0]) {
            const s: any = hits[0]._source;
            console.log('  sample cold _source.act =', JSON.stringify(s.act));
            console.log('  sample cold @transfer    =', JSON.stringify(s['@transfer']));
        }
        // deltas
        const rd = await client.search<any>({
            index: DELTA_INDEX, size: 200,
            query: { match_all: {} }, sort: [{ block_num: 'asc' }]
        });
        const dhits = rd.hits.hits;
        const dWith = dhits.filter((h: any) =>
            h._source?.data !== undefined || h._source?.value !== undefined).length;
        check('cold ES delta sample has NO data/value', dWith === 0,
            `${dhits.length} cold delta docs scanned, ${dWith} carry data/value`);
    }

    // ---------------------------------------------------------------------
    // TEST 1 + 2: get_actions hydrated + parity vs hot
    // ---------------------------------------------------------------------
    section('TEST 1+2: get_actions hydrated + parity vs hot (alien.worlds, limit=50, sort=asc)');
    let hydratedActions: any[] = [];
    {
        // sort=asc requires a bound -> use a block-number "after" in the cold range.
        const res = await fastify.inject({
            method: 'GET',
            url: urls.actions + '?account=alien.worlds&limit=50&sort=asc&after=190373745&before=190374244'
        });
        check('get_actions HTTP 200', res.statusCode === 200, `status=${res.statusCode}`);
        const body = res.json();
        hydratedActions = body.actions || [];
        check('get_actions returned actions', hydratedActions.length > 0,
            `returned=${hydratedActions.length}, total=${JSON.stringify(body.total)}`);

        const withData = hydratedActions.filter(a => a.act && a.act.data !== undefined).length;
        check('ALL returned actions carry hydrated act.data', withData === hydratedActions.length,
            `${withData}/${hydratedActions.length} have act.data`);

        // Parity vs hot reference, matched by global_sequence.
        const gsSet = new Set<string>(hydratedActions.map(a => String(a.global_sequence)));
        const hotMap = await loadHotActions(gsSet);
        check('hot reference matched for returned gs', hotMap.size === gsSet.size,
            `matched ${hotMap.size}/${gsSet.size} global_sequences in hot NDJSON`);

        let parity = 0, mismatch = 0;
        const mismatches: string[] = [];
        for (const a of hydratedActions) {
            const gs = String(a.global_sequence);
            const hot = hotMap.get(gs);
            if (!hot) continue;
            const expected = hotExpectedActData(hot);
            if (deepEq(a.act.data, expected)) parity++;
            else {
                mismatch++;
                if (mismatches.length < 3) {
                    mismatches.push(`gs=${gs} name=${a.act.name}\n      cold-hydrated=${JSON.stringify(a.act.data)}\n      hot-expected =${JSON.stringify(expected)}`);
                }
            }
        }
        check('PARITY: every hydrated act.data == hot @-merged act.data',
            mismatch === 0 && parity === hydratedActions.length,
            `parity=${parity}/${hydratedActions.length}, mismatch=${mismatch}`);
        if (mismatches.length) mismatches.forEach(m => console.log('  MISMATCH ' + m));

        // Concrete before/after sample for a transfer (exercises the @-merge).
        const transfer = hydratedActions.find(a => a.act?.name === 'transfer');
        if (transfer) {
            const gs = String(transfer.global_sequence);
            const cold = await rawColdActionByGs(client, gs);
            console.log('\n  --- BEFORE/AFTER (transfer gs=' + gs + ') ---');
            console.log('  COLD _source.act (no data) :', JSON.stringify(cold?.act));
            console.log('  COLD _source.@transfer     :', JSON.stringify(cold?.['@transfer']));
            console.log('  RESPONSE act.data (hydrated+merged):', JSON.stringify(transfer.act.data));
            const hot = hotMap.get(gs);
            console.log('  HOT act.data (@-merged)    :', JSON.stringify(hotExpectedActData(hot)));
            check('transfer: cold _source has NO act.data', cold?.act?.data === undefined);
            check('transfer: response act.data has from/to/quantity/memo',
                !!transfer.act.data && ['from', 'to', 'quantity', 'memo'].every(k => k in transfer.act.data),
                JSON.stringify(transfer.act.data));
        } else {
            console.log('  (no transfer action in this page — @-merge sample skipped)');
        }
    }

    // ---------------------------------------------------------------------
    // TEST 3: opt-out -> NO archive-supplied act.data (cold passthrough)
    // ---------------------------------------------------------------------
    // IMPORTANT NUANCE about the @-merge:
    //   The route ALWAYS runs mergeActionMeta(action), which merges any
    //   @<name> extended-metadata that ES itself stores (e.g. @transfer =
    //   {from,to,amount,symbol}) into act.data — independent of hydration.
    //   So for an "extended action" (transfer/newaccount/...), act.data is
    //   NEVER fully absent: it contains the @-meta fields ES already had.
    //   The ARCHIVE-only fields (a transfer's `quantity` and `memo`) are what
    //   the opt-out must suppress. For a NON-extended action (e.g. eosio
    //   onblock, no @<name> key) act.data IS fully absent under opt-out.
    section('TEST 3: get_actions &hydrate=false -> NO archive-supplied act.data (cold passthrough)');
    {
        // (a) alien.worlds page is all transfers -> assert archive-only fields
        //     (quantity, memo) are ABSENT (they can only come from the archive),
        //     while the always-merged @transfer meta (from/to/amount/symbol)
        //     may still be present.
        const res = await fastify.inject({
            method: 'GET',
            url: urls.actions + '?account=alien.worlds&limit=50&sort=asc&after=190373745&before=190374244&hydrate=false'
        });
        check('get_actions(hydrate=false) HTTP 200', res.statusCode === 200, `status=${res.statusCode}`);
        const body = res.json();
        const acts = body.actions || [];
        const transfers = acts.filter((a: any) => a.act?.name === 'transfer');
        const leaked = transfers.filter((a: any) => {
            const d = a.act?.data || {};
            return ('quantity' in d) || ('memo' in d);
        }).length;
        check('opt-out: NO archive-only field (quantity/memo) on any transfer',
            transfers.length > 0 && leaked === 0,
            `${leaked}/${transfers.length} transfers leaked an archive-only field (expected 0)`);
        if (transfers[0]) {
            console.log('  sample opt-out transfer act.data =', JSON.stringify(transfers[0].act.data),
                '(only @transfer meta; no archive quantity/memo)');
        }

        // (b) a NON-extended action (eosio onblock has no @<name> meta) -> under
        //     opt-out act.data must be FULLY ABSENT (pure cold passthrough).
        const res2 = await fastify.inject({
            method: 'GET',
            url: urls.actions + '?account=eosio&act.name=onblock&limit=20&sort=asc&after=190373745&before=190374244&hydrate=false'
        });
        const body2 = res2.json();
        const onblocks = body2.actions || [];
        const withData2 = onblocks.filter((a: any) => a.act && a.act.data !== undefined).length;
        check('opt-out: NON-extended action (onblock) act.data FULLY absent',
            onblocks.length > 0 && withData2 === 0,
            `${withData2}/${onblocks.length} onblock actions carry act.data (expected 0)`);

        // (c) control: same onblock query WITH hydration -> act.data present.
        const res3 = await fastify.inject({
            method: 'GET',
            url: urls.actions + '?account=eosio&act.name=onblock&limit=20&sort=asc&after=190373745&before=190374244'
        });
        const onblocks3 = (res3.json().actions) || [];
        const withData3 = onblocks3.filter((a: any) => a.act?.data !== undefined).length;
        check('control: onblock WITH hydration -> act.data present',
            onblocks3.length > 0 && withData3 === onblocks3.length,
            `${withData3}/${onblocks3.length} onblock actions carry act.data (expected all)`);
    }

    // ---------------------------------------------------------------------
    // TEST 4: get_deltas hydrated + parity, and opt-out
    // ---------------------------------------------------------------------
    section('TEST 4: get_deltas hydrated + parity vs hot, and &hydrate=false opt-out');
    {
        // eosio/global is a single-row table that exists in the cold range.
        const url = urls.deltas + '?code=eosio&table=global&scope=eosio&limit=50&sort=desc&after=190373745&before=190374244';
        const res = await fastify.inject({ method: 'GET', url });
        check('get_deltas HTTP 200', res.statusCode === 200, `status=${res.statusCode}`);
        const body = res.json();
        const deltas = body.deltas || [];
        check('get_deltas returned deltas', deltas.length > 0,
            `returned=${deltas.length}, total=${JSON.stringify(body.total)}`);

        const withPayload = deltas.filter((d: any) =>
            d.data !== undefined || d.value !== undefined).length;
        check('ALL returned deltas carry hydrated data/value', withPayload === deltas.length,
            `${withPayload}/${deltas.length} carry data/value`);

        // parity vs hot
        const keySet = new Set<string>(deltas.map((d: any) =>
            `${d.block_num}|${d.code}|${d.scope}|${d.table}|${d.primary_key}`));
        const hotMap = await loadHotDeltas(keySet);
        check('hot delta reference matched', hotMap.size === keySet.size,
            `matched ${hotMap.size}/${keySet.size} delta keys in hot NDJSON`);

        let dParity = 0, dMismatch = 0;
        const dm: string[] = [];
        for (const d of deltas) {
            const k = `${d.block_num}|${d.code}|${d.scope}|${d.table}|${d.primary_key}`;
            const hot = hotMap.get(k);
            if (!hot) continue;
            const exp = hotExpectedDeltaData(hot);
            const okData = exp.data !== undefined ? deepEq(d.data, exp.data) : d.data === undefined;
            const okValue = exp.value !== undefined ? d.value === exp.value : d.value === undefined;
            if (okData && okValue) dParity++;
            else {
                dMismatch++;
                if (dm.length < 3) dm.push(`key=${k}\n      cold=${JSON.stringify({data:d.data,value:d.value})}\n      hot =${JSON.stringify(exp)}`);
            }
        }
        check('PARITY: every hydrated delta payload == hot payload',
            dMismatch === 0 && dParity === deltas.length,
            `parity=${dParity}/${deltas.length}, mismatch=${dMismatch}`);
        if (dm.length) dm.forEach(m => console.log('  MISMATCH ' + m));

        if (deltas[0]) {
            console.log('  sample hydrated delta data =', JSON.stringify(deltas[0].data).slice(0, 200) + '...');
        }

        // Also prove a 'value' (raw hex) delta hydrates. bcbrawlers/craftcounts in range.
        const vres = await fastify.inject({
            method: 'GET',
            url: urls.deltas + '?code=bcbrawlers&table=craftcounts&limit=20&sort=desc&after=190373745&before=190374244'
        });
        const vbody = vres.json();
        const vdeltas = vbody.deltas || [];
        const withValue = vdeltas.filter((d: any) => typeof d.value === 'string').length;
        check('get_deltas hydrates raw-hex value rows', vdeltas.length > 0 && withValue > 0,
            `${withValue}/${vdeltas.length} carry a hex value (e.g. ${vdeltas[0]?.value})`);

        // opt-out
        const ores = await fastify.inject({ method: 'GET', url: url + '&hydrate=false' });
        const obody = ores.json();
        const odeltas = obody.deltas || [];
        const oWith = odeltas.filter((d: any) => d.data !== undefined || d.value !== undefined).length;
        check('opt-out: NO delta carries data/value', oWith === 0,
            `${oWith}/${odeltas.length} carry data/value (expected 0)`);
    }

    await fastify.close();
    await client.close();

    // ---------------------------------------------------------------------
    section('SUMMARY');
    console.log(`  PASS=${PASS}  FAIL=${FAIL}`);
    if (FAIL > 0) {
        console.log('  FAILURES:');
        failures.forEach(f => console.log('    - ' + f));
        process.exitCode = 1;
    } else {
        console.log('  ALL CHECKS PASSED');
    }
}

main().catch((e) => {
    console.error('HARNESS ERROR:', e);
    process.exitCode = 2;
});
