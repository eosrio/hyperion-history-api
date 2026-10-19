import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {assertBulkAcknowledged, assertIdentity, assertOwner, syntheticDocument, validateOptions, type Options} from './es955.ts';

const repetitions = 5;
const recoveryTimeoutMs = 15_000;

export function parseFailureOptions(args: string[]): Options {
    const values = new Map<string, string>();
    const allowed = new Set(['url', 'cluster-name', 'cluster-uuid', 'prefix', 'output', 'transport']);
    for (let i = 0; i < args.length; i += 2) {
        assert.ok(args[i].startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--'), 'flags require values');
        const name = args[i].slice(2);
        assert.ok(allowed.has(name) && !values.has(name), `unknown or duplicate flag: ${name}`);
        values.set(name, args[i + 1]);
    }
    return validateOptions({url: values.get('url') ?? '', clusterName: values.get('cluster-name') ?? '',
        clusterUuid: values.get('cluster-uuid') ?? '', prefix: values.get('prefix') ?? '', output: values.get('output') ?? '',
        transport: (values.get('transport') ?? 'default') as Options['transport'], documents: 1000});
}

/** Require real timeout metadata; an ordinary empty successful response is not this case. */
export function assertTimedOut(response: any): void {
    assert.equal(response.timed_out, true, 'timeout fault was not exercised');
    assert.equal(response._shards.failed, 0, 'a timeout must not be mistaken for a shard exception');
    assert.ok(response._shards.total >= 3, 'timeout reduction must span multiple shards');
}

/** Timeout metadata alone may describe a deadline that elapsed before script collection. */
export function assertCollectionDeadline(response: any, state: any): void {
    assertTimedOut(response);
    assert.ok(Number.isSafeInteger(state.delay_started) && state.delay_started > 0, 'collection delay never started');
    assert.ok(Number.isSafeInteger(state.slow_query_timed_out) && state.slow_query_timed_out > 0,
        'slow script did not observe the query deadline');
}

/** Client aborts and query deadlines do not establish cancellation of server work. */
export function assertServerTaskCancelled(state: any): void {
    assert.ok(Number.isSafeInteger(state.task_cancelled) && state.task_cancelled > 0,
        'server task cancellation was not observed');
    assert.ok(Number.isSafeInteger(state.slow_task_cancelled) && state.slow_task_cancelled > 0,
        'slow script did not observe task cancellation');
}

export function assertFailedShard(response: any): void {
    assert.equal(response.timed_out, false, 'failed-shard case unexpectedly timed out');
    assert.equal(response._shards.failed, 1, 'exactly the injected shard must fail');
    assert.ok(response._shards.successful >= 2, 'healthy and empty shards must remain available');
    assert.match(JSON.stringify(response._shards.failures), /injected qualification shard failure/);
}

export function assertCancelled(result: any): void {
    if (result.ok) {
        assert.ok(result.body._shards.failed > 0, 'cancelled query returned complete success');
        assert.match(JSON.stringify(result.body._shards.failures), /task_cancelled_exception/);
    } else assert.match(JSON.stringify(result.error), /abort|cancel/i);
}

export function recoveryCounters(snapshot: any) {
    assert.equal(snapshot._nodes?.failed, 0, 'node statistics failed');
    assert.equal(snapshot._nodes?.total, 1, 'exactly one measured fixture node required');
    assert.equal(snapshot._nodes?.successful, 1, 'fixture node statistics missing');
    const entries = Object.entries(snapshot.nodes ?? {});
    assert.equal(entries.length, 1, 'no complete measured node');
    const result = Object.fromEntries(entries.map(([id, raw]) => {
        const node: any = raw;
        return [id, {requestBytes: node.breakers.request.estimated_size_in_bytes,
            requestTrips: node.breakers.request.tripped, openContexts: node.indices.search.open_contexts,
            queryCurrent: node.indices.search.query_current, fetchCurrent: node.indices.search.fetch_current,
            heapBytes: node.jvm.mem.heap_used_in_bytes, gc: node.jvm.gc.collectors}];
    }));
    assertCounterSet(result); return result;
}

function assertCounterSet(counters: any) {
    assert.equal(Object.keys(counters).length, 1, 'one complete measured node required');
    for (const values of Object.values(counters) as any[]) {
        for (const field of ['requestBytes', 'requestTrips', 'openContexts', 'queryCurrent', 'fetchCurrent', 'heapBytes']) {
            assert.ok(Number.isFinite(values[field]) && values[field] >= 0, `invalid or missing ${field}`);
        }
    }
}

export function assertCompleteTasks(response: any): any[] {
    assert.equal(response.node_failures?.length ?? 0, 0, 'task node listing failed');
    assert.equal(response.task_failures?.length ?? 0, 0, 'task listing failed');
    assert.ok(Array.isArray(response.tasks), 'complete ungrouped task list required');
    return response.tasks;
}

export function assertRecovered(before: any, after: any): void {
    assertCounterSet(before); assertCounterSet(after);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'node set changed');
    for (const id of Object.keys(before)) {
        assert.equal(after[id].openContexts, before[id].openContexts, `search contexts retained on ${id}`);
        assert.equal(after[id].queryCurrent, before[id].queryCurrent, `query work retained on ${id}`);
        assert.equal(after[id].fetchCurrent, before[id].fetchCurrent, `fetch work retained on ${id}`);
        assert.ok(after[id].requestBytes <= before[id].requestBytes, `request breaker bytes retained on ${id}`);
        assert.equal(after[id].requestTrips, before[id].requestTrips, `unexpected breaker trip on ${id}`);
    }
}

async function pause(ms: number) { await new Promise(resolve => setTimeout(resolve, ms)); }
function errorRecord(error: any) {
    return {name: error.name, message: error.message, statusCode: error.meta?.statusCode ?? error.statusCode,
        body: error.meta?.body};
}

/** Controlled server fault injection. Never a production sizing or complete leak-freedom claim. */
export async function runFailureQualification(options: Options) {
    validateOptions(options);
    const [{Client, HttpConnection}, connection, helpers] = await Promise.all([
        import('@elastic/elasticsearch'), import('../../build/indexer/helpers/es-connection.js'),
        import('../../build/api/routes/v2-history/get_actions/functions.js')
    ]);
    const inherited = connection.esConnectionOptions();
    const client = new Client({node: options.url, maxRetries: 0, requestTimeout: 15_000, ...inherited,
        ...(options.transport === 'http' ? {Connection: HttpConnection, agent: {keepAlive: true, maxSockets: 256}} : {})});
    let output;
    try { output = await open(options.output, 'wx'); }
    catch (error) { await client.close(); throw error; }
    const owner = randomUUID();
    const names = Object.fromEntries(['healthy', 'slow', 'fail', 'empty'].map(role => [role, `${options.prefix}-${role}`]));
    const indices = Object.values(names);
    const created: string[] = [];
    const pending = new Set<Promise<any>>();
    const keys = new Set<string>();
    const started = performance.now();
    const report: any = {schema_version: 1, started_at: new Date().toISOString(), options, owner, status: 'running',
        runtime: {node: process.version, bun: process.versions.bun ?? null,
            selected_connection: options.transport === 'http' || inherited.Connection === HttpConnection ? 'HttpConnection' : 'UndiciConnection'},
        limits: ['Synthetic bounded mappings; not entire Hyperion or upgrade acceptance',
            'Finite fault/recovery sample, not proof of absence of all heap leaks',
            'JVM heap and GC are observed separately from request-breaker/context release',
            'Late script completion after HTTP abort is not successful result delivery after a closed phase consumer',
            'Single-node, no replica, rolling-upgrade or sustained pressure qualification'],
        trials: [], snapshots: [], cleanup: [], acknowledged_documents: 0};
    const identity = async () => {
        const info = await client.info(); assertIdentity(info, options); return info;
    };
    const owned = async () => {
        await identity();
        for (const index of created) assertOwner(await client.indices.getMapping({index}), index, owner);
    };
    const plugin = async (key?: string, reset = false) => {
        const response = await fetch(`${options.url}/_hyperion_qualifier/${reset ? 'reset' : 'state'}${key ? `?key=${encodeURIComponent(key)}` : ''}`,
            {method: reset ? 'POST' : 'GET', signal: AbortSignal.timeout(5000)});
        const text = await response.text(); assert.ok(response.ok, `fault plugin ${response.status}: ${text}`);
        return JSON.parse(text);
    };
    const tasks = async () => {
        const response: any = await client.tasks.list({actions: 'indices:data/read/search*', detailed: true, group_by: 'none'});
        return assertCompleteTasks(response).filter((task: any) => task.headers?.['X-Opaque-Id']?.startsWith(options.prefix) ||
            task.headers?.['x-opaque-id']?.startsWith(options.prefix));
    };
    const snapshot = async (phase: string) => {
        const raw = await client.nodes.stats({metric: ['indices', 'jvm', 'breaker', 'thread_pool', 'process']});
        const result = {phase, at: new Date().toISOString(), counters: recoveryCounters(raw), tasks: await tasks(), raw};
        report.snapshots.push(result); return result;
    };
    const drain = async (phase: string, baseline: any, key?: string) => {
        const recoveryStarted = performance.now();
        const deadline = recoveryStarted + recoveryTimeoutMs;
        let consecutive = 0;
        while (performance.now() < deadline) {
            const sample = await snapshot(phase);
            const state = key ? await plugin(key) : {active: 0};
            assert.ok(performance.now() < deadline, `recovery sample completed outside ${recoveryTimeoutMs} ms window: ${phase}`);
            try {
                assertRecovered(baseline.counters, sample.counters);
                assert.equal(sample.tasks.length, 0, 'owned search tasks remain');
                assert.equal(state.active, 0, 'fault script work remains');
                assert.equal(state.delay_active ?? 0, 0, 'script delay remains');
                if (++consecutive === 3) return {snapshot: sample, plugin: state, elapsed_ms: performance.now() - recoveryStarted};
            } catch { consecutive = 0; }
            await pause(100);
        }
        throw new Error(`resources did not recover within ${recoveryTimeoutMs} ms: ${phase}`);
    };
    const capture = async (request: any, key: string, signal?: AbortSignal) => {
        const begin = performance.now();
        const promise = client.search(request, {opaqueId: key, signal})
            .then(body => ({ok: true, key, request, body, wall_ms: performance.now() - begin}),
                error => ({ok: false, key, request, error: errorRecord(error), wall_ms: performance.now() - begin}));
        pending.add(promise);
        try { const result = await promise; report.last_request = result; return result; } finally { pending.delete(promise); }
    };
    const allDocs = Array.from({length: 1000}, (_, i) => ({...syntheticDocument(i + 1),
        qualifier_role: i < 400 ? 'healthy' : i < 800 ? 'slow' : 'fail', payload: 'q'.repeat(2048)}));
    const query = (direction: 'asc' | 'desc', target: string[] = indices, extra: any = {}) => {
        const input = {sort: direction, after: '1000001', limit: '1000'};
        const q: any = {bool: {must: [], must_not: [], boost: 1}};
        helpers.applyAccountFilters(input, q); helpers.applyTimeFilter(input, q);
        const body: any = {index: target, size: 1000, track_total_hits: true, query: q, timeout: '5s',
            request_cache: false, _source: ['global_sequence'], allow_partial_search_results: true, pre_filter_shard_size: 128, ...extra};
        helpers.addSortedBy(input, body, helpers.getSortDir(input));
        return body;
    };
    const assertHits = (response: any, docs: any[], direction: 'asc' | 'desc') => {
        const ordered = [...docs].sort((a, b) => direction === 'asc' ? a.global_sequence - b.global_sequence : b.global_sequence - a.global_sequence);
        assert.deepEqual(response.hits.hits.map((hit: any) => hit._id), ordered.map(doc => String(doc.global_sequence)), 'exact sorted IDs differ');
        assert.deepEqual(response.hits.hits.map((hit: any) => hit.sort[0]), ordered.map(doc => doc.global_sequence), 'sort values differ');
    };
    const healthyControl = async (phase: string) => {
        for (const direction of ['asc', 'desc'] as const) {
            const result = await capture(query(direction), `${options.prefix}-${phase}-${direction}`);
            assert.equal(result.ok, true); const body = (result as any).body;
            assert.equal(body.timed_out, false); assert.equal(body._shards.failed, 0);
            assert.equal(body.hits.total.value, allDocs.length); assert.equal(body.hits.total.relation, 'eq');
            assertHits(body, allDocs, direction); report.trials.push({kind: 'healthy-control', phase, direction, ...result});
        }
    };
    const gateQuery = (direction: 'asc' | 'desc', key: string, mode: string, extra: any = {}) => {
        keys.add(key);
        const body = query(direction, indices, extra);
        body.query.bool.must.push({script: {script: {lang: 'hyperion_qualifier', source: 'gate', params: {key, mode, delay_ms: 1500}}}});
        return body;
    };
    const waitForEntry = async (key: string) => {
        const until = performance.now() + 10_000;
        while (performance.now() < until) {
            const state = await plugin(key);
            if (state.delay_active > 0) return state;
            await pause(20);
        }
        throw new Error(`slow script did not enter: ${key}`);
    };
    try {
        report.server = await identity();
        const health = await client.cluster.health(); assert.equal(health.number_of_nodes, 1, 'isolated single node required');
        report.client = JSON.parse(await readFile(new URL('../../node_modules/@elastic/elasticsearch/package.json', import.meta.url), 'utf8')).version;
        report.transport = JSON.parse(await readFile(new URL('../../node_modules/@elastic/transport/package.json', import.meta.url), 'utf8')).version;
        assert.equal(report.client, '8.19.1'); assert.equal(report.transport, '8.10.1');
        report.plugin = await plugin(); assert.equal(report.plugin.fixture_only, true);
        report.source_hashes = {};
        for (const path of ['scripts/qualification/es955-failures.ts', 'scripts/qualification/fixture/HyperionQualifierPlugin.java',
            'build/api/routes/v2-history/get_actions/functions.js', 'build/indexer/helpers/es-connection.js', 'package-lock.json']) {
            report.source_hashes[path] = createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex');
        }
        for (const index of indices) assert.equal(await client.indices.exists({index}), false, 'refusing existing probe index');
        for (const index of indices) {
            await identity(); created.push(index);
            await client.indices.create({index, settings: {number_of_shards: 1, number_of_replicas: 0, refresh_interval: '-1',
                'sort.field': 'global_sequence', 'sort.order': 'desc'}, mappings: {_meta: {hyperion_es955_owner: owner}, properties: {
                global_sequence: {type: 'long'}, block_num: {type: 'long'}, '@timestamp': {type: 'date'}, qualifier_role: {type: 'keyword'},
                payload: {type: 'text', index: false}, 'act.account': {type: 'keyword'}, 'act.name': {type: 'keyword'},
                'act.data': {enabled: false}, notified: {type: 'keyword'}}}}, {requestTimeout: 45_000});
        }
        const ready = await client.cluster.health({index: indices, wait_for_status: 'green', timeout: '30s'});
        assert.equal(ready.timed_out, false);
        await owned();
        const expected = allDocs.map(doc => ({index: names[doc.qualifier_role], id: String(doc.global_sequence)}));
        const operations = allDocs.flatMap((doc, i) => [{index: {_index: expected[i].index, _id: expected[i].id}}, doc]);
        assertBulkAcknowledged(await client.bulk({operations}), expected); report.acknowledged_documents = allDocs.length;
        await owned(); await client.indices.refresh({index: created});
        report.effective_indices = await client.indices.get({index: created, include_defaults: true});
        report.effective_nodes = await client.nodes.info({metric: ['settings', 'plugins']});
        await healthyControl('warmup');
        const baseline = await snapshot('baseline');
        assert.equal(baseline.tasks.length, 0); report.baseline = baseline;
        for (const node of Object.values(baseline.counters) as any[]) {
            assert.equal(node.openContexts, 0); assert.equal(node.queryCurrent, 0); assert.equal(node.fetchCurrent, 0);
            assert.equal(node.requestBytes, 0, 'warm idle request-breaker baseline must be zero');
        }
        for (let round = 0; round < repetitions; round++) {
            for (const direction of ['asc', 'desc'] as const) {
                for (const reversed of [false, true]) {
                    const key = `${options.prefix}-timeout-${round}-${direction}-${reversed ? 'r' : 'f'}`;
                    const target = reversed ? [...indices].reverse() : indices;
                    const request = query(direction, target, {timeout: '5s'});
                    request.query.bool.must.push({hyperion_qualifier_timeout: {index_suffix: '-slow'}});
                    const result = await capture(request, key); assert.equal(result.ok, true);
                    const body = (result as any).body; assertTimedOut(body);
                    assertHits(body, allDocs.filter(doc => doc.qualifier_role !== 'slow'), direction);
                    report.trials.push({kind: 'precollection-timeout', round, direction, reversed, ...result});
                    if (!reversed) {
                        const strict = await capture({...request, allow_partial_search_results: false}, key);
                        assert.equal(strict.ok, false, 'strict timed-out query returned partial success');
                        assert.equal((strict as any).error.statusCode, 429, 'unexpected ES timeout rejection status');
                        assert.match(JSON.stringify((strict as any).error.body), /time|timeout/i);
                        report.trials.push({kind: 'strict-precollection-timeout', round, direction, ...strict});
                    }
                }
                const timeoutKey = `${options.prefix}-deadline-${round}-${direction}`;
                const timeout = await capture(gateQuery(direction, timeoutKey, 'timeout', {timeout: '50ms'}), timeoutKey);
                const timeoutState = await plugin(timeoutKey);
                assert.equal(timeout.ok, true); assertCollectionDeadline((timeout as any).body, timeoutState);
                assertHits((timeout as any).body, allDocs.filter(doc => doc.qualifier_role !== 'slow'), direction);
                report.trials.push({kind: 'collection-deadline', round, direction, ...timeout, plugin: timeoutState});
                await plugin(timeoutKey, true);
                const key = `${options.prefix}-fail-${round}-${direction}`;
                const request = gateQuery(direction, key, 'fail');
                const result = await capture(request, key); assert.equal(result.ok, true);
                assertFailedShard((result as any).body);
                assertHits((result as any).body, allDocs.filter(doc => doc.qualifier_role !== 'fail'), direction);
                report.trials.push({kind: 'partial-shard-failure', round, direction, ...result, plugin: await plugin(key)});
                const strict = await capture({...request, allow_partial_search_results: false}, key);
                assert.equal(strict.ok, false, 'strict failed-shard query returned partial success');
                assert.match(JSON.stringify((strict as any).error.body), /injected qualification shard failure/);
                report.trials.push({kind: 'strict-shard-failure', round, direction, ...strict});
                await plugin(key, true);
            }
            for (const cancellation of ['http-abort', 'task-cancel'] as const) {
                const key = `${options.prefix}-${cancellation}-${round}`;
                const controller = new AbortController();
                const work = capture(gateQuery('desc', key, 'cancel'), key, controller.signal);
                const entered = await waitForEntry(key);
                const active = await snapshot(`${cancellation}:active:${round}`);
                const matching = active.tasks.filter((task: any) => task.action === 'indices:data/read/search');
                assert.equal(matching.length, 1, 'exact owned coordinating search task required');
                if (cancellation === 'http-abort') controller.abort();
                else {
                    await identity();
                    const task = matching[0];
                    const stillOwned = await tasks();
                    assert.ok(stillOwned.some((current: any) => current.node === task.node && current.id === task.id));
                    await client.tasks.cancel({task_id: `${task.node}:${task.id}`});
                }
                const result = await work;
                assertCancelled(result);
                const recovered = await drain(`${cancellation}:recovery:${round}`, baseline, key);
                assertServerTaskCancelled(recovered.plugin);
                report.trials.push({kind: cancellation, round, entered, active, ...result, recovered});
                await plugin(key, true);
            }
            const lateKey = `${options.prefix}-late-client-${round}`;
            const lateController = new AbortController();
            const lateWork = capture(gateQuery('desc', lateKey, 'late'), lateKey, lateController.signal);
            const lateEntry = await waitForEntry(lateKey);
            lateController.abort();
            const lateResult = await lateWork; assertCancelled(lateResult);
            const lateRecovery = await drain(`late-client:recovery:${round}`, baseline, lateKey);
            assert.ok(lateRecovery.plugin.slow_completed > 0, 'bounded noncooperative script did not finish after client abort');
            report.trials.push({kind: 'late-script-after-client-abort', round, entry: lateEntry, ...lateResult, recovered: lateRecovery,
                limit: 'Not proof of successful transport result delivered after a closed phase consumer'});
            await plugin(lateKey, true);
            report.rounds ??= [];
            report.rounds.push({round, recovery: await drain(`wave:${round}:recovery`, baseline)});
            await healthyControl(`wave${round}`);
        }
        report.final_recovery = await drain('final-recovery', baseline);
        report.status = 'passed';
    } catch (error: any) {
        report.status = 'failed'; report.error = {message: error.message, stack: error.stack};
        try { report.fault_state_at_failure = await plugin(); } catch { /* preserve original failure */ }
    }
    finally {
        await Promise.allSettled([...pending]);
        for (const key of keys) try { if ((await plugin(key)).active === 0) await plugin(key, true); } catch { /* exact index cleanup still follows */ }
        for (const index of created.reverse()) {
            try {
                await identity();
                if (await client.indices.exists({index})) {
                    assertOwner(await client.indices.getMapping({index}), index, owner);
                    await client.indices.delete({index});
                }
                assert.equal(await client.indices.exists({index}), false);
                report.cleanup.push({index, ok: true});
            } catch (error: any) { report.status = 'failed'; report.cleanup.push({index, ok: false, error: error.message}); }
        }
        try { await client.close(); } catch (error: any) { report.status = 'failed'; report.close_error = error.message; }
        report.completed_at = new Date().toISOString(); report.wall_ms = performance.now() - started;
        await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close();
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const report = await runFailureQualification(parseFailureOptions(process.argv.slice(2)));
    console.log(JSON.stringify({status: report.status, trials: report.trials.length, error: report.error, cleanup: report.cleanup}));
    if (report.status !== 'passed') process.exitCode = 1;
}
