import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

export type Options = {
    url: string; clusterName: string; clusterUuid: string; prefix: string; output: string;
    transport: 'default' | 'http'; documents: number;
};
export const expectedVersion = '9.5.5';
const requestTimeout = 15_000;
const repetitions = 5;
const pageSize = 128;
const writeBatchSize = 100;
const epoch = Date.parse('2026-10-18T00:00:00Z');
const require = createRequire(import.meta.url);

export function validateOptions(options: Options): Options {
    const target = new URL(options.url);
    assert.equal(target.protocol, 'http:', 'only an explicitly isolated HTTP loopback target is allowed');
    assert.ok(['127.0.0.1', '[::1]'].includes(target.hostname), 'target must be a numeric loopback address');
    assert.ok(target.port && target.port !== '9200', 'use an explicit non-default test port');
    assert.ok(!target.username && !target.password && target.pathname === '/' && !target.search && !target.hash,
        'target must have no credentials, path, query, or fragment');
    assert.match(options.clusterName, /^hyperion-(es955|es198)-[a-z0-9-]+$/, 'cluster name must identify an isolated qualification cluster');
    assert.match(options.clusterUuid, /^[a-zA-Z0-9_-]{16,64}$/, 'exact cluster UUID required');
    assert.match(options.prefix, /^hyp-es955-[a-z0-9]{8,32}$/, 'unique test-only prefix required');
    assert.ok(['default', 'http'].includes(options.transport), 'transport must be default or http');
    assert.ok(Number.isInteger(options.documents) && options.documents >= 1000 && options.documents <= 9000,
        'seed documents must be an integer between 1000 and 9000 (leaving room for mixed writes and route pagination)');
    assert.ok(options.output, 'output file required');
    return options;
}

export function assertIdentity(info: any, options: Options): void {
    assert.equal(info.cluster_name, options.clusterName, 'cluster name changed or does not match');
    assert.equal(info.cluster_uuid, options.clusterUuid, 'cluster UUID changed or does not match');
    assert.equal(info.version?.number, expectedVersion, 'server must be exactly Elasticsearch 9.5.5');
    assert.equal(info.tagline, 'You Know, for Search', 'unexpected server identity');
}

export function assertOwner(mapping: any, index: string, token: string): void {
    assert.equal(mapping[index]?.mappings?._meta?.hyperion_es955_owner, token,
        `refusing mutation or cleanup of index without this run's ownership marker: ${index}`);
}

export function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

export function summary(values: number[]) {
    return {count: values.length, min: values.length ? Math.min(...values) : null,
        p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99),
        max: values.length ? Math.max(...values) : null};
}

export function syntheticDocument(sequence: number) {
    const account = sequence % 3 === 0 ? 'alice' : 'bob';
    return {global_sequence: sequence, block_num: 1_000_000 + sequence,
        '@timestamp': new Date(epoch + sequence * 1000).toISOString(),
        notified: [account], receipts: [{receiver: account, global_sequence: sequence}],
        act: {account: sequence % 2 ? 'eosio.token' : 'atomicassets',
            name: sequence % 4 < 2 ? 'transfer' : 'logmint', authorization: [{actor: account, permission: 'active'}],
            data: {qualification: true, sequence}}};
}

export function assertBulkAcknowledged(response: any, expected: {index: string; id: string}[]): void {
    assert.equal(response.errors, false, 'bulk reported failed work');
    assert.equal(response.items?.length, expected.length, 'bulk item count differs from submitted work');
    response.items.forEach((item: any, i: number) => {
        const result = item.index;
        assert.ok(result && result.status >= 200 && result.status < 300 && !result.error, `bulk item ${i} failed`);
        assert.equal(result._id, expected[i].id, `bulk item ${i} ID mismatch`);
        assert.equal(result._index, expected[i].index, `bulk item ${i} index mismatch`);
        assert.equal(result.result, 'created', `bulk item ${i} was not a new document`);
    });
}

function parseOptions(args: string[]): Options {
    const flags = new Map<string, string>();
    const allowed = new Set(['url', 'cluster-name', 'cluster-uuid', 'prefix', 'output', 'transport', 'documents']);
    for (let i = 0; i < args.length; i += 2) {
        assert.ok(args[i].startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--'), 'flags require a value');
        const key = args[i].slice(2);
        assert.ok(allowed.has(key) && !flags.has(key), `unknown or duplicate flag: ${key}`);
        flags.set(key, args[i + 1]);
    }
    return validateOptions({url: flags.get('url') ?? '', clusterName: flags.get('cluster-name') ?? '',
        clusterUuid: flags.get('cluster-uuid') ?? '', prefix: flags.get('prefix') ?? '',
        output: flags.get('output') ?? '', transport: (flags.get('transport') ?? 'default') as Options['transport'],
        documents: Number(flags.get('documents') ?? 2000)});
}

function packageVersion(name: string): string {
    // These pinned packages export index.js but intentionally hide the package.json subpath.
    return JSON.parse(readFileSync(join(dirname(require.resolve(name)), 'package.json'), 'utf8')).version;
}

/** Finite synthetic probe, not a chain replay, capacity benchmark, or complete release qualification. */
export async function runQualification(options: Options) {
    validateOptions(options);
    const [{Client, HttpConnection}, helpers, connection] = await Promise.all([
        import('@elastic/elasticsearch'),
        import('../../build/api/routes/v2-history/get_actions/functions.js'),
        import('../../build/indexer/helpers/es-connection.js')
    ]);
    const inheritedConnection = connection.esConnectionOptions();
    const client = new Client({node: options.url, requestTimeout, maxRetries: 0,
        ...inheritedConnection, ...(options.transport === 'http' ? {Connection: HttpConnection,
            agent: {keepAlive: true, maxSockets: 256}} : {})});
    const token = randomUUID();
    const indices = ['a', 'b', 'empty'].map(suffix => `${options.prefix}-${suffix}`);
    const created: string[] = [];
    const cpuStart = process.cpuUsage();
    const memoryStart = process.memoryUsage();
    const started = performance.now();
    const report: any = {schema_version: 1, status: 'running', started_at: new Date().toISOString(), options,
        scope: 'single-node deterministic synthetic compatibility and timing sample',
        limits: ['Not a full Hyperion process or chain replay', 'No throughput or production sizing claim',
            'No PIT, search_after, timeout/failed-shard injection, replica, rolling upgrade, old-index migration, or pressure stress exercised',
            'Byte counts are UTF-8 JSON payload estimates, not compressed HTTP wire bytes',
            'Process CPU and memory include orchestration; ES server stats are separate',
            'Mappings are a bounded projection of the Hyperion action template, not the entire template'],
        versions: {runtime: process.version, bun: process.versions.bun ?? null,
            client: packageVersion('@elastic/elasticsearch'), transport: packageVersion('@elastic/transport'),
            selected_connection: options.transport === 'http' || inheritedConnection.Connection === HttpConnection ? 'HttpConnection' : 'UndiciConnection',
            ES_HTTP_CONNECTION: process.env.ES_HTTP_CONNECTION ?? null},
        samples: [], windows: [], compatibility_headers: {}, cleanup: [], acknowledged_documents: 0,
        failed_measured_requests: 0, failed_bulk_items: 0};
    const execute = async (kind: string, phase: string, input: any, call: () => Promise<any>) => {
        const begin = performance.now();
        const sample: any = {kind, phase, input_json_bytes: Buffer.byteLength(JSON.stringify(input)), request_ok: false};
        try {
            const response = await call();
            sample.wall_ms = performance.now() - begin;
            sample.server_took_ms = response.took ?? null;
            sample.output_json_bytes = Buffer.byteLength(JSON.stringify(response));
            // HTTP/client completion is distinct from the oracle assertions performed by callers.
            sample.request_ok = true;
            return response;
        } catch (error: any) {
            sample.wall_ms = performance.now() - begin;
            sample.error = error.message;
            report.failed_measured_requests++;
            throw error;
        } finally { report.samples.push(sample); }
    };
    const identity = async () => {
        const response = await client.info({}, {meta: true});
        assertIdentity(response.body, options);
        report.compatibility_headers.response = response.headers;
        return response.body;
    };
    client.diagnostic.on('request', (_error: any, event: any) => {
        const params = event?.meta?.request?.params;
        const headers = params?.headers;
        if (headers) report.compatibility_headers.request = headers;
        if (params?.path?.endsWith('/_bulk')) report.compatibility_headers.bulk_request = headers;
        if (params?.path?.endsWith('/_search')) report.compatibility_headers.search_request = headers;
    });
    const owned = async (names: string[]) => {
        await identity();
        for (const index of names) assertOwner(await client.indices.getMapping({index}), index, token);
    };
    const snapshot = async () => ({at: new Date().toISOString(),
        nodes: await client.nodes.stats({metric: ['indices', 'jvm', 'process', 'breaker', 'indexing_pressure', 'thread_pool']}),
        indices: await client.indices.stats({index: indices})});
    const docs = Array.from({length: options.documents}, (_, i) => syntheticDocument(i + 1));
    const indexFor = (sequence: number) => indices[sequence % 2];
    const write = async (documents: any[], phase: string) => {
        await owned(indices);
        const expected = documents.map(doc => ({index: indexFor(doc.global_sequence), id: String(doc.global_sequence)}));
        const operations = documents.flatMap((doc, i) => [{index: {_index: expected[i].index, _id: expected[i].id}}, doc]);
        const response = await execute('bulk', phase, {operations}, () => client.bulk({operations, refresh: false}));
        report.failed_bulk_items += response.items.filter((item: any) => !item.index || item.index.status >= 300 || item.index.error).length;
        assertBulkAcknowledged(response, expected);
        report.acknowledged_documents += documents.length;
    };
    const refresh = async () => {
        await owned(indices);
        const response = await client.indices.refresh({index: indices});
        assert.equal(response._shards?.failed, 0, 'refresh failed shards');
    };
    const queryCases = (ceiling: number) => [
        {name: 'all-desc', query: {sort: 'desc', after: '1000001'}, match: (_doc: any) => true},
        {name: 'all-asc', query: {sort: 'asc', after: '1000001'}, match: (_doc: any) => true},
        {name: 'account', query: {account: 'alice'}, match: (doc: any) => doc.notified.includes('alice')},
        {name: 'code-action', query: {filter: 'eosio.token:transfer'},
            match: (doc: any) => doc.act.account === 'eosio.token' && doc.act.name === 'transfer'},
        {name: 'timestamp', query: {after: new Date(epoch + 101_000).toISOString(), before: new Date(epoch + 299_000).toISOString()},
            match: (doc: any) => doc.global_sequence >= 101 && doc.global_sequence <= 299},
        {name: 'generic-term', query: {'act.name': 'logmint'}, match: (doc: any) => doc.act.name === 'logmint'}
    ].map(test => ({...test, expected: docs.filter(doc => doc.global_sequence <= ceiling && test.match(doc))}));
    const reads = async (phase: string, ceiling: number) => {
        for (const test of queryCases(ceiling)) {
            const direction = test.query.sort === 'asc' ? 'asc' : 'desc';
            const expected = test.expected.sort((a, b) => direction === 'asc' ? a.global_sequence - b.global_sequence : b.global_sequence - a.global_sequence);
            const ids: string[] = [];
            for (let from = 0; from < Math.max(1, expected.length); from += pageSize) {
                const query = {...test.query, skip: String(from), limit: String(pageSize)};
                const queryStruct: any = {bool: {must: [{range: {global_sequence: {lte: ceiling}}}], must_not: [], boost: 1}};
                helpers.applyAccountFilters(query, queryStruct);
                helpers.applyGenericFilters(query, queryStruct, new Set());
                helpers.applyTimeFilter(query, queryStruct);
                helpers.applyCodeActionFilters(query, queryStruct);
                const body: any = {index: indices, ...helpers.getSkipLimit(query, 10000), timeout: '10s', track_total_hits: true, query: queryStruct};
                body.from = body.skip; body.size = body.limit; delete body.skip; delete body.limit;
                helpers.addSortedBy(query, body, helpers.getSortDir(query));
                const response = await execute(`search:${test.name}`, phase, body, () => client.search(body));
                assert.equal(response.timed_out, false, 'search timed out');
                assert.equal(response._shards.failed, 0, 'search failed shards');
                assert.equal(response.hits.total.relation, 'eq', 'inexact total count');
                assert.equal(response.hits.total.value, expected.length, `${test.name} total mismatch`);
                assert.deepEqual(response.hits.hits.map((hit: any) => hit._source.global_sequence),
                    expected.slice(from, from + pageSize).map(doc => doc.global_sequence), `${test.name} sorted page mismatch`);
                ids.push(...response.hits.hits.map((hit: any) => hit._id));
            }
            assert.deepEqual(ids, expected.map(doc => String(doc.global_sequence)), `${test.name} exact IDs differ`);
        }
        const empty = await execute('search:empty', phase, {index: indices[2], sort: {global_sequence: 'desc'}},
            () => client.search({index: indices[2], sort: {global_sequence: 'desc'}, track_total_hits: true}));
        assert.equal(empty.hits.total.value, 0, 'empty shard returned documents');
        assert.equal(empty._shards.failed, 0, 'empty shard search failed');
    };
    // Reserve the report before touching the target; an existing evidence file is never overwritten.
    let output;
    try { output = await open(options.output, 'wx'); }
    catch (error) { await client.close(); throw error; }
    try {
        report.server = await identity();
        assert.equal(packageVersion('@elastic/elasticsearch'), '8.19.1', 'qualify the pinned client, not a changed dependency');
        assert.equal(packageVersion('@elastic/transport'), '8.10.1', 'qualify the pinned transport');
        const health = await client.cluster.health();
        assert.equal(health.number_of_nodes, 1, 'this first qualification requires an isolated single node');
        for (const index of indices) assert.equal(await client.indices.exists({index}), false, `refusing pre-existing namespace: ${index}`);
        report.source_hashes = {};
        for (const source of ['src/api/routes/v2-history/get_actions/functions.ts', 'src/indexer/helpers/es-connection.ts',
            'src/indexer/definitions/index-templates.ts', 'package-lock.json']) {
            report.source_hashes[source] = createHash('sha256').update(await readFile(new URL(`../../${source}`, import.meta.url))).digest('hex');
        }
        for (const index of indices) {
            await identity();
            // Track attempted creates: a timed-out acknowledgement may still have created the owned index.
            created.push(index);
            await client.indices.create({index, settings: {number_of_shards: 4, number_of_replicas: 0,
                refresh_interval: '1s', codec: 'best_compression', 'sort.field': 'global_sequence', 'sort.order': 'desc'},
                mappings: {_meta: {hyperion_es955_owner: token}, properties: {
                    '@timestamp': {type: 'date'}, global_sequence: {type: 'long'}, block_num: {type: 'long'},
                    notified: {type: 'keyword'}, 'receipts.receiver': {type: 'keyword'}, 'receipts.global_sequence': {type: 'long'},
                    'act.account': {type: 'keyword'}, 'act.name': {type: 'keyword'},
                    'act.authorization.actor': {type: 'keyword'}, 'act.authorization.permission': {enabled: false},
                    'act.data': {enabled: false}}}}, {requestTimeout: 45_000});
        }
        const ready = await client.cluster.health({index: indices, wait_for_status: 'green', timeout: '15s'});
        assert.equal(ready.timed_out, false, 'owned indices did not become green in time');
        report.effective_indices = await client.indices.get({index: indices, include_defaults: true});
        report.before = await snapshot();
        for (let offset = 0; offset < docs.length; offset += 500) await write(docs.slice(offset, offset + 500), 'seed');
        await refresh();
        await reads('warmup', docs.length);
        for (const phase of ['read-only', 'mixed']) {
            for (let iteration = 1; iteration <= repetitions; iteration++) {
                const windowStarted = performance.now();
                const ceiling = docs.length;
                const readsPromise = reads(`${phase}:${iteration}`, ceiling);
                if (phase === 'mixed') {
                    const added = Array.from({length: writeBatchSize}, (_, i) => syntheticDocument(ceiling + i + 1));
                    // Always settle reads before cleanup even when the concurrent writer fails.
                    const outcomes = await Promise.allSettled([readsPromise, write(added, `${phase}:${iteration}`)]);
                    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
                    docs.push(...added);
                    await refresh();
                } else await readsPromise;
                report.windows.push({phase, iteration, wall_ms: performance.now() - windowStarted,
                    stable_query_ceiling: ceiling, acknowledged_documents: report.acknowledged_documents});
            }
        }
        await reads('final', docs.length);
        const count = await client.count({index: indices});
        assert.equal(count.count, docs.length, 'final document count differs from acknowledged work');
        report.after = await snapshot();
        report.status = 'passed';
    } catch (error: any) {
        report.status = 'failed';
        report.error = {message: error.message, stack: error.stack};
    } finally {
        for (const index of created.reverse()) {
            try {
                await identity();
                if (!await client.indices.exists({index})) {
                    report.cleanup.push({index, ok: true, absent: true});
                    continue;
                }
                await owned([index]);
                await client.indices.delete({index});
                assert.equal(await client.indices.exists({index}), false, `index still exists after cleanup: ${index}`);
                report.cleanup.push({index, ok: true});
            } catch (error: any) {
                report.cleanup.push({index, ok: false, error: error.message});
                report.status = 'failed';
            }
        }
        try { await client.close(); } catch (error: any) { report.status = 'failed'; report.close_error = error.message; }
        report.wall_ms = performance.now() - started;
        report.cpu_microseconds = process.cpuUsage(cpuStart);
        report.memory_before_bytes = memoryStart;
        report.memory_after_bytes = process.memoryUsage();
        report.timing_warnings = report.samples.filter((sample: any) => typeof sample.server_took_ms === 'number' &&
            sample.server_took_ms > sample.wall_ms + 5).map((sample: any) => ({kind: sample.kind, phase: sample.phase,
            wall_ms: sample.wall_ms, server_took_ms: sample.server_took_ms,
            message: 'Server-reported took exceeds client wall by more than rounding tolerance; investigate timing before interpreting performance'}));
        report.distributions = {};
        for (const phase of ['read-only', 'mixed']) {
            for (const kind of ['bulk', 'search']) {
                const samples = report.samples.filter((sample: any) => sample.phase.startsWith(`${phase}:`) && sample.kind.startsWith(kind));
                report.distributions[`${phase}:${kind}`] = {wall_ms: summary(samples.map((sample: any) => sample.wall_ms)),
                    server_took_ms: summary(samples.map((sample: any) => sample.server_took_ms).filter((value: any) => typeof value === 'number')),
                    input_json_bytes: samples.reduce((sum: number, sample: any) => sum + sample.input_json_bytes, 0),
                    output_json_bytes: samples.reduce((sum: number, sample: any) => sum + (sample.output_json_bytes ?? 0), 0)};
            }
        }
        report.completed_at = new Date().toISOString();
        try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); }
        finally { await output.close(); }
    }
    return report;
}

if (process.argv[1] && pathToFileURL(fileURLToPath(new URL(import.meta.url))).href === pathToFileURL(process.argv[1]).href) {
    try {
        const report = await runQualification(parseOptions(process.argv.slice(2)));
        console.log(JSON.stringify({status: report.status, output: report.options.output, wall_ms: report.wall_ms,
            acknowledged_documents: report.acknowledged_documents, error: report.error, cleanup: report.cleanup}));
        if (report.status !== 'passed') process.exitCode = 1;
    } catch (error: any) { console.error(error.message); process.exitCode = 1; }
}
