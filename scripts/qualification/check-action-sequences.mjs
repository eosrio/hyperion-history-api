import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {Client} from '@elastic/elasticsearch';
import {Serializer} from '@elastic/transport';

// This engineering prototype owns its server. It never accepts a borrowed URL,
// image override, credentials, operator index name, or live cluster settings.
const image = 'docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c';
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `hyp-action-sequences-${run}`, network = `${name}-net`;
const clusterName = `hyperion-action-sequences-${run}`;
const qualifier = 'action-sequences';
const output = process.argv[2];
if (process.argv.length > 3) throw new Error('Usage: node check-action-sequences.mjs [output.json]');
const maximum = 0xffffffffffffffffn, signedMaximum = 0x7fffffffffffffffn;
const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER), signedIntegerMaximum = 0x7fffffff;
const prefix = 'h45_sequences_v1', valueField = `${prefix}.global.value`, keyField = `${prefix}.global.key`;
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const docker = args => execFileSync('docker', args, {encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024}).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {schemaVersion: 1, status: 'running', createdAt: new Date().toISOString(), run, image,
    purpose: 'Native design experiments and gated production module qualification; not live activation or release qualification',
    qualification: {productionModules: false, productionAdapter: false, liveActivation: false, durableCoverageAuthority: false,
        retainedHistoryUpgrade: false, abiProof: false, wireTestnet: false, release: false},
    runtime: {node: process.versions.node, bun: process.versions.bun ?? null},
    checks: [], observations: {}, cleanup: {containers: [], network: false, verified: false}};
const containers = new Map(), clients = new Set(), pits = new Set();
let networkId;
// The pinned transport may leave only unreferenced handles while a native
// request is pending. Keep the runner alive through its owned-resource finally.
const keepAlive = setInterval(() => {}, 1000);

function labels(role) {
    return ['--label', `io.eosrio.qualifier=${qualifier}`, '--label', `io.eosrio.run=${run}`, '--label', `io.eosrio.role=${role}`];
}

function owned(value, role) {
    const actual = value.Config?.Labels ?? value.Labels;
    assert.equal(actual?.['io.eosrio.qualifier'], qualifier, 'Refuse a foreign qualifier');
    assert.equal(actual?.['io.eosrio.run'], run, 'Refuse a foreign run');
    assert.equal(actual?.['io.eosrio.role'], role, 'Refuse a foreign fixture role');
}

async function check(label, action) {
    const started = process.hrtime.bigint();
    try {
        const details = await action();
        report.checks.push({name: label, status: 'passed', elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
            ...(details === undefined ? {} : {details})});
    } catch (error) {
        report.checks.push({name: label, status: 'failed', elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
            error: String(error.stack ?? error)});
        throw error;
    }
}

function decimal(input, {positive = false} = {}) {
    assert.equal(typeof input, 'string', 'Sequence input must already be exact text');
    assert.match(input, /^(0|[1-9][0-9]{0,19})$/);
    const value = BigInt(input);
    assert(value <= maximum && (!positive || value > 0n), 'Sequence range');
    return input;
}

const pair = input => ({value: decimal(input), key: input.padStart(20, '0')});
const nativeField = field => ({'global_sequence': valueField, 'receipts.recv_sequence': `${prefix}.receipts.receive.value`,
    'receipts.auth_sequence.sequence': `${prefix}.receipts.authorization.sequence.value`})[field];
const scalarMapping = () => ({type: 'object', dynamic: 'strict', properties: {value: {type: 'unsigned_long'}, key: {type: 'keyword'}}});
const sequenceMapping = () => ({type: 'object', dynamic: 'strict', properties: {
    version: {type: 'byte'}, global: scalarMapping(), code_sequence: {type: 'long'}, abi_sequence: {type: 'long'},
    receipts: {type: 'object', dynamic: 'strict', properties: {receiver: {type: 'keyword'}, global: scalarMapping(), receive: scalarMapping(),
        authorization: {type: 'object', dynamic: 'strict', properties: {account: {type: 'keyword'}, sequence: scalarMapping()}}}}
}});

const legacyProperties = {global_sequence: {type: 'long'}, block_num: {type: 'long'}, '@timestamp': {type: 'date'},
    abi_sequence: {type: 'integer'}, code_sequence: {type: 'integer'}, category: {type: 'keyword'},
    trx_id: {type: 'keyword'}, act: {enabled: false}, protocol: {enabled: false},
    receipts: {properties: {receiver: {type: 'keyword'}, global_sequence: {type: 'long'}, recv_sequence: {type: 'long'},
        auth_sequence: {properties: {account: {type: 'keyword'}, sequence: {type: 'long'}}}}}};
const legacySettings = {number_of_shards: 4, number_of_replicas: 0, refresh_interval: '1s', codec: 'best_compression',
    'sort.field': 'global_sequence', 'sort.order': 'desc', 'translog.durability': 'request'};

function logical(sequence, category = 'covered', block = 1, metadata = 0) {
    decimal(sequence, {positive: true});
    assert(Number.isSafeInteger(metadata) && metadata >= 0 && metadata <= 0xffffffff);
    return {global_sequence: sequence, block_num: block, '@timestamp': '2026-10-20T00:00:00.000Z', category,
        trx_id: sequence.padStart(64, '0'), act: {account: 'alpha', name: 'act', data: '00'},
        code_sequence: metadata, abi_sequence: metadata,
        receipts: [{receiver: 'alpha', global_sequence: sequence, recv_sequence: sequence,
            auth_sequence: [{account: 'alpha', sequence}]}]};
}

function physical(action) {
    const document = structuredClone(action);
    const exact = {version: 1, global: pair(action.global_sequence), code_sequence: action.code_sequence, abi_sequence: action.abi_sequence,
        receipts: action.receipts.map(receipt => ({receiver: receipt.receiver, global: pair(receipt.global_sequence), receive: pair(receipt.recv_sequence),
            authorization: receipt.auth_sequence.map(entry => ({account: entry.account, sequence: pair(entry.sequence)}))}))};
    if (BigInt(document.global_sequence) > signedMaximum) delete document.global_sequence;
    for (const receipt of document.receipts) {
        for (const field of ['global_sequence', 'recv_sequence']) if (BigInt(receipt[field]) > signedMaximum) delete receipt[field];
        for (const entry of receipt.auth_sequence) if (BigInt(entry.sequence) > signedMaximum) delete entry.sequence;
    }
    for (const field of ['code_sequence', 'abi_sequence']) if (document[field] > signedIntegerMaximum) delete document[field];
    document[prefix] = exact;
    return document;
}

function complete(response) {
    assert.equal(response.timed_out, false);
    assert.equal(response._shards.failed, 0);
    assert.equal(response._shards.successful, response._shards.total);
    return response;
}

function total(response) {
    const hits = response.hits.total;
    assert.equal(typeof hits, 'object');
    assert.equal(hits.relation, 'eq');
    assert(Number.isSafeInteger(hits.value) && hits.value >= 0);
    return hits.value;
}

function sequenceOf(hit) {
    const source = hit._source;
    if (source[prefix] !== undefined) {
        assert.equal(source[prefix].version, 1);
        const text = decimal(source[prefix].global.value, {positive: true});
        assert.equal(source[prefix].global.key, text.padStart(20, '0'));
        return text;
    }
    assert(Number.isSafeInteger(source.global_sequence) && source.global_sequence > 0, 'Unqualified legacy source');
    return String(source.global_sequence);
}

// Prototype compiler: only root predicates are supported here. Whole predicate
// sets are compiled inside each disjoint cohort, before counting or pagination.
function predicate(field, entry, ceiling) {
    if (entry.op === 'eq' || entry.op === 'ne') {
        const term = BigInt(decimal(entry.value)) > ceiling ? {match_none: {}} : {term: {[field]: entry.value}};
        return entry.op === 'ne' ? {bool: {must_not: [term]}} : term;
    }
    if (entry.op === 'in') {
        const values = entry.values.map(value => decimal(value)).filter(value => BigInt(value) <= ceiling);
        return values.length ? {terms: {[field]: values}} : {match_none: {}};
    }
    assert.equal(entry.op, 'range');
    let lower = 0n, upper = ceiling;
    for (const [operator, value] of Object.entries(entry.bounds)) {
        const bound = BigInt(decimal(value));
        if (operator === 'gte') lower = lower > bound ? lower : bound;
        else if (operator === 'gt') lower = lower > bound + 1n ? lower : bound + 1n;
        else if (operator === 'lte') upper = upper < bound ? upper : bound;
        else if (operator === 'lt') upper = upper < bound - 1n ? upper : bound - 1n;
        else assert.fail('Unknown range operator');
    }
    return lower > upper ? {match_none: {}} : {range: {[field]: {gte: String(lower), lte: String(upper)}}};
}

function membership(predicates = []) {
    return {bool: {should: [
        {bool: {filter: [{term: {[`${prefix}.version`]: 1}}, ...predicates.map(entry => predicate(valueField, entry, maximum))]}},
        {bool: {must_not: [{exists: {field: `${prefix}.version`}}], filter: [
            {range: {global_sequence: {gte: '1', lte: String(safeMaximum)}}},
            ...predicates.map(entry => predicate('global_sequence', entry, safeMaximum))]}}
    ], minimum_should_match: 1}};
}

const mixedSort = order => ({_script: {type: 'string', order, script: {lang: 'painless',
    params: {zeros: '00000000000000000000', key: keyField, version: `${prefix}.version`, legacy: 'global_sequence'}, source: `
if (doc.containsKey(params.version) && doc[params.version].size() != 0) {
  if (doc[params.version].value != 1 || !doc.containsKey(params.key) || doc[params.key].size() != 1) {
    throw new IllegalArgumentException('incomplete exact sequence namespace');
  }
  return doc[params.key].value;
}
if (!doc.containsKey(params.legacy) || doc[params.legacy].size() != 1) {
  throw new IllegalArgumentException('missing legacy sequence');
}
long value = doc[params.legacy].value;
if (value <= 0 || value > 9007199254740991L) {
  throw new IllegalArgumentException('unqualified legacy sequence');
}
String text = Long.toString(value);
return params.zeros.substring(text.length()) + text;`}}});

const covered = {term: {category: 'covered'}};
const query = (base, predicates) => ({bool: {filter: [base, membership(predicates)]}});
const unknownCoverage = base => ({bool: {filter: [base], must_not: [{term: {[`${prefix}.version`]: 1}}], should: [
    {range: {global_sequence: {gt: String(safeMaximum)}}}, {range: {global_sequence: {lte: '0'}}},
    {bool: {must_not: [{exists: {field: 'global_sequence'}}]}}
], minimum_should_match: 1}});

function rememberPit(state, response) {
    if (response.pit_id && response.pit_id !== state.id) {
        pits.delete(state); state.id = response.pit_id; pits.add(state);
    }
}

async function openPit(client, index) {
    const opened = await client.openPointInTime({index, keep_alive: '1m', allow_partial_search_results: false});
    assert.equal(opened._shards.failed, 0); assert.equal(opened._shards.successful, opened._shards.total);
    const state = {client, id: opened.id}; pits.add(state); return state;
}

async function closePit(state) {
    if (!pits.has(state)) return;
    const receipt = await state.client.closePointInTime({id: state.id});
    assert.equal(receipt.succeeded, true);
    assert(receipt.num_freed > 0);
    pits.delete(state);
}

async function coverage(state, base) {
    const response = complete(await state.client.search({pit: {id: state.id, keep_alive: '1m'}, size: 0,
        query: unknownCoverage(base), track_total_hits: true, allow_partial_search_results: false}));
    rememberPit(state, response);
    if (total(response) !== 0) throw Object.assign(new Error('Exact action sequence coverage is incomplete for this scope'),
        {code: 'ACTION_SEQUENCE_COVERAGE_UNAVAILABLE', statusCode: 503});
}

async function pitSearch(state, base = covered, predicates = [], options = {}) {
    await coverage(state, base);
    const response = complete(await state.client.search({pit: {id: state.id, keep_alive: '1m'}, query: query(base, predicates),
        sort: [mixedSort(options.order ?? 'asc')], size: options.size ?? 100, track_total_hits: true,
        allow_partial_search_results: false, ...(options.after === undefined ? {} : {search_after: options.after}),
        ...(options.from === undefined ? {} : {from: options.from})}));
    rememberPit(state, response);
    for (const hit of response.hits.hits) {
        assert.equal(typeof hit.sort[0], 'string'); assert.equal(hit.sort[0], sequenceOf(hit).padStart(20, '0'));
        for (const token of hit.sort) if (typeof token === 'number') assert(Number.isSafeInteger(token), 'Unsafe numeric PIT tie-breaker');
    }
    return response;
}

async function launch(role, denySort = false) {
    const containerName = role === 'server' ? name : `${name}-${role}`;
    const state = {role, name: containerName}; containers.set(containerName, state);
    const settings = denySort ? ['-e', 'script.allowed_contexts=update'] : [];
    state.id = docker(['run', '-d', '--name', containerName, '--network', network, ...labels(role),
        '--cpus', '2', '--memory', '2g', '-p', '127.0.0.1::9200',
        '--tmpfs', '/usr/share/elasticsearch/data:rw,uid=1000,gid=0,size=268435456',
        '-e', 'discovery.type=single-node', '-e', `cluster.name=${clusterName}-${role}`,
        '-e', 'xpack.security.enabled=false', '-e', 'xpack.security.autoconfiguration.enabled=false',
        '-e', 'xpack.ml.enabled=false', '-e', 'ingest.geoip.downloader.enabled=false',
        '-e', 'ES_JAVA_OPTS=-Xms512m -Xmx512m', ...settings, image]);
    assert.match(state.id, /^[a-f0-9]{64}$/);
    const inspected = JSON.parse(docker(['inspect', state.id]))[0]; owned(inspected, role);
    assert.equal(inspected.Id, state.id); assert.equal(inspected.Name, '/' + containerName); assert.equal(inspected.Config.Image, image);
    const bindings = inspected.NetworkSettings.Ports['9200/tcp'];
    assert.equal(bindings.length, 1); assert.equal(bindings[0].HostIp, '127.0.0.1');
    const port = Number(bindings[0].HostPort); assert(Number.isInteger(port) && port > 1024 && port !== 9200);
    state.url = `http://127.0.0.1:${port}`;
    let info, lastError;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(state.url, {signal: AbortSignal.timeout(2000)});
            if (!response.ok) throw new Error(`Startup identity status ${response.status}`);
            info = await response.json(); break;
        } catch (error) {lastError = error; await sleep(250);}
    }
    assert.equal(info?.version?.number, '9.5.5', `Owned server did not start: ${lastError?.message ?? 'no response'}`);
    assert.equal(info.cluster_name, `${clusterName}-${role}`); assert.match(info.cluster_uuid, /^[A-Za-z0-9_-]{16,64}$/);
    // Open the pinned client only after the owned server is listening. A
    // port-closed startup attempt must not poison its pool or hide a deadline.
    state.client = new Client({node: state.url, requestTimeout: 10000, maxRetries: 0}); clients.add(state.client);
    const nativeInfo = await state.client.info({}, {signal: AbortSignal.timeout(10000)});
    assert.equal(nativeInfo.version.number, info.version.number); assert.equal(nativeInfo.cluster_uuid, info.cluster_uuid);
    state.server = {version: info.version.number, clusterName: info.cluster_name, clusterUuid: info.cluster_uuid};
    return state;
}

async function rejection(action, pattern) {
    let failure;
    try {await action();} catch (error) {failure = error;}
    assert(failure, 'Expected the native server to reject this operation');
    const text = JSON.stringify(failure.meta?.body ?? {message: failure.message});
    assert.match(text, pattern);
    return {statusCode: failure.meta?.statusCode, message: text.slice(0, 2048)};
}

async function qualifyProductionModules(client, parentChain) {
    // Exercise emitted native-Node production modules, not another implementation
    // of their codec/compiler. The authority below owns a finite input manifest;
    // it is explicitly not the still-unimplemented durable host coverage journal.
    const {ActionHistoryAdapter} = await import('../../build/indexer/history/action-history-adapter.js');
    const {ensureActionSequenceMappings, restoreActionSequenceStorage, encodeActionSequenceStorage} =
        await import('../../build/indexer/history/action-sequence-storage.js');
    const {ElasticRoutes} = await import('../../build/indexer/helpers/elastic-routes.js');
    const chain = `${parentChain}-adapter`, index = `${chain}-action-v1-000001`, empty = `${chain}-action-v1-000002`;
    const source = [logical('1', 'adapter'), ...['2', '8', '9', '10', '11', '9007199254740991', '9007199254740992',
        '9007199254740993', '9223372036854775807', '9223372036854775808', '9223372036854775809',
        '18446744073709551614', '18446744073709551615'].map((sequence, position) => {
        const action = logical(sequence, 'adapter', position + 2, [2147483647, 2147483648, 4294967295][position % 3]);
        action.act.data = {global_sequence: 1.25, exact_contract_string: '0001', retained: false, values: [0, null]};
        if (sequence === '18446744073709551615') {
            action.code_sequence = 4294967295; action.abi_sequence = 4294967295;
            action.receipts[0].global_sequence = '18446744073709551614';
            action.receipts.push({receiver: 'beta', global_sequence: sequence, recv_sequence: '9223372036854775809',
                auth_sequence: [{account: 'bob', sequence: '18446744073709551615'}, {account: 'alice', sequence: '9007199254740993'}]});
        }
        return action;
    })];
    const expected = source.map(action => action.global_sequence).sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
    const manifest = {kind: 'owned-fixture', target: [index, empty], expected: source, emptyBlocks: [100, 101]};
    const sourceDigest = sha256(JSON.stringify(manifest));
    const identity = new Map(), incomplete = new Set(); let generation = 1, leases = 0, releases = 0;
    const authority = {
        async acquire(snapshot) {
            assert(snapshot.indices.every(entry => identity.get(entry.name) === entry.uuid), 'Concrete fixture UUID mismatch');
            const pinned = generation; leases++;
            return {generation: `${run}:${pinned}`, source: `owned-fixture:${sourceDigest}`, indices: snapshot.indices,
                async assertComplete() {
                    if (snapshot.indices.some(entry => incomplete.has(entry.name))) {
                        throw Object.assign(new Error('Source manifest membership is incomplete'), {statusCode: 503});
                    }
                },
                async assertCurrent() {
                    if (generation !== pinned) throw Object.assign(new Error('Source coverage generation changed'), {statusCode: 503});
                },
                async release() {releases++;}};
        }
    };
    const adapter = new ActionHistoryAdapter(client, chain, authority);
    report.productionModuleFixture = {sourceDigest, sourceRows: source.length, emptyBlocks: manifest.emptyBlocks,
        purpose: 'Finite manifest and fixture-only coverage authority; durable host journal and live activation remain absent'};
    report.productionModuleFixture.artifacts = Object.fromEntries(['action-history-adapter', 'action-history-coverage',
        'action-sequence-storage', 'action-sequence-query-plan', 'action-source-projection'].map(module => [module, {
        sourceSha256: sha256(readFileSync(new URL(`../../src/indexer/history/${module}.ts`, import.meta.url))),
        emittedSha256: sha256(readFileSync(new URL(`../../build/indexer/history/${module}.js`, import.meta.url)))
    }]));
    await check('production mapping guard adds namespace with acknowledged readback and preserves retained history', async () => {
        for (const name of [index, empty]) await client.indices.create({index: name, settings: legacySettings,
            mappings: {dynamic: 'strict', properties: legacyProperties}});
        const legacy = structuredClone(source[0]); legacy.global_sequence = 1;
        await client.index({index, id: '1', document: legacy, refresh: true, wait_for_active_shards: 'all'});
        const before = (await client.indices.getSettings({index, flat_settings: true}))[index].settings;
        report.productionModuleFixture.retentionProbe = {
            mapping: (await client.indices.getMapping({index}))[index].mappings._source,
            settings: (await client.indices.getSettings({index, flat_settings: true, include_defaults: true}))[index]
        };
        assert.deepEqual(await ensureActionSequenceMappings(client, chain), {inspected: 2, updated: 2});
        assert.deepEqual(await ensureActionSequenceMappings(client, chain), {inspected: 2, updated: 0});
        assert.deepEqual((await client.get({index, id: '1'}))._source, legacy);
        assert.deepEqual((await client.indices.getSettings({index, flat_settings: true}))[index].settings, before);
        for (const name of [index, empty]) {
            const settings = (await client.indices.getSettings({index: name, flat_settings: true}))[name].settings;
            identity.set(name, settings['index.uuid']); assert.equal(settings['index.sort.field'], 'global_sequence');
        }
        return {concreteUuids: Object.fromEntries(identity), retainedLegacyRow: true, fullReindex: false};
    });
    await check('opt-in production bulk route acknowledges exact full-range writes and idempotent redelivery', async () => {
        const requests = [], receipts = [];
        const routes = new ElasticRoutes({chain, config: {scaling: {}, settings: {index_version: 'v1', index_partition_size: 1000}},
            ingestClients: [{async bulk(request) {
                requests.push(request); const receipt = await client.bulk({...request, refresh: true, wait_for_active_shards: 'all'});
                receipts.push(receipt); return receipt;
            }}]}, undefined, {exactActionSequenceStorage: true});
        const deliveries = source.slice(1).map((action, position) => ({content: Buffer.from(JSON.stringify(action)),
            fields: {deliveryTag: position + 1}, properties: {}}));
        async function route() {
            const acknowledged = [], requeued = [], channel = Object.assign(new EventEmitter(), {
                ack(message) {acknowledged.push(message.fields.deliveryTag);},
                nack(message, allUpTo, requeue) {assert.equal(allUpTo, false); assert.equal(requeue, true); requeued.push(message.fields.deliveryTag);}
            });
            const size = await new Promise(resolve => routes.routes.action(deliveries, channel, resolve));
            assert.equal(size, deliveries.length); assert.equal(acknowledged.length, deliveries.length); assert.deepEqual(requeued, []);
        }
        await route(); await route(); assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0].pipeline, '_none');
        for (const receipt of receipts) {assert.equal(receipt.errors, false); for (const item of receipt.items) assert.equal(item.index._shards.failed, 0);}
        assert.equal((await client.count({index})).count, source.length);
        for (const action of source.slice(1)) {
            const hit = await client.get({index, id: action.global_sequence});
            assert.equal(hit._id, action.global_sequence); assert.deepEqual(restoreActionSequenceStorage(hit._source), action);
        }
        return {itemsPerDelivery: deliveries.length, deliveries: 2, remainingLogicalRows: source.length};
    });
    await check('production query adapter preserves exact membership counts and metadata predicates', async () => {
        const cases = [
            [{term: {global_sequence: '9007199254740993'}}, ['9007199254740993']],
            [{range: {global_sequence: {gte: '9007199254740992', lt: '9223372036854775809'}}},
                ['9007199254740992', '9007199254740993', '9223372036854775807', '9223372036854775808']],
            [{bool: {must: [{range: {global_sequence: {gte: '8', lte: '11'}}}], must_not: [{term: {global_sequence: '10'}}]}}, ['8', '9', '11']],
            [{terms: {global_sequence: ['1', '9007199254740993', '18446744073709551615']}}, ['1', '9007199254740993', '18446744073709551615']],
            [{term: {'receipts.recv_sequence': '9223372036854775809'}}, ['9223372036854775809', '18446744073709551615']],
            [{term: {'receipts.auth_sequence.sequence': '18446744073709551615'}}, ['18446744073709551615']],
            [{term: {code_sequence: 4294967295}}, source.filter(action => action.code_sequence === 4294967295).map(action => action.global_sequence)
                .sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1)]
        ];
        const context = await adapter.open([index, empty]);
        try {
            for (const [query, selected] of cases) {
                const result = await context.search({query, sort: {global_sequence: 'asc'}, size: 100, track_total_hits: true});
                assert.deepEqual(result.hits.hits.map(hit => hit._source.global_sequence), selected); assert.equal(total(result), selected.length);
                assert.equal(await context.count(query), selected.length);
                for (const hit of result.hits.hits) {assert.equal(hit._source[prefix], undefined); assert.equal(hit.fields, undefined);}
            }
        } finally {await context.close();}
        return {predicateCases: cases.length, countSharesPit: true};
    });
    await check('production multivalue min/max sorts and negated pure-should predicates follow native semantics', async () => {
        const context = await adapter.open(index);
        try {
            for (const mode of ['min', 'max']) for (const order of ['asc', 'desc']) {
                const selected = [...source].sort((left, right) => {
                    const member = action => action.receipts.map(receipt => BigInt(receipt.recv_sequence))
                        .reduce((a, b) => mode === 'min' ? (a < b ? a : b) : (a > b ? a : b));
                    const a = member(left), b = member(right);
                    return a === b ? (BigInt(left.global_sequence) < BigInt(right.global_sequence) ? -1 : 1) :
                        (a < b ? -1 : 1) * (order === 'asc' ? 1 : -1);
                }).map(action => action.global_sequence);
                const result = await context.search({sort: [{'receipts.recv_sequence': {order, mode}}, {global_sequence: 'asc'}], size: 100});
                assert.deepEqual(result.hits.hits.map(hit => hit._source.global_sequence), selected);
                assert(result.hits.hits.every(hit => typeof hit.sort[0] === 'string' && typeof hit.sort[1] === 'string'));
            }
            const counters = await context.search({sort: [{code_sequence: 'desc'}, {global_sequence: 'asc'}], size: 100});
            assert(counters.hits.hits.every(hit => typeof hit.sort[0] === 'number' && Number.isSafeInteger(hit.sort[0])));
            assert.deepEqual(counters.hits.hits.map(hit => hit._source.code_sequence), [...source].map(action => action.code_sequence).sort((a, b) => b - a));
            const query = {bool: {must_not: [{bool: {should: [{term: {global_sequence: '1'}}], minimum_should_match: 0}}]}};
            assert.equal(await context.count(query), source.length - 1);
        } finally {await context.close();}
    });
    await check('production PIT offset and search_after pages preserve exact strings across old and new rows', async () => {
        for (const order of ['asc', 'desc']) {
            const selected = order === 'asc' ? expected : [...expected].reverse(), context = await adapter.open([index, empty]);
            try {
                const offset = [], cursor = []; let after;
                for (let from = 0; from < selected.length; from += 3) {
                    const result = await context.search({sort: {global_sequence: order}, from, size: 3});
                    offset.push(...result.hits.hits.map(hit => hit._source.global_sequence));
                }
                assert.deepEqual(offset, selected);
                do {
                    const result = await context.search({sort: {global_sequence: order}, size: 3, ...(after ? {search_after: after} : {})});
                    if (!result.hits.hits.length) break;
                    cursor.push(...result.hits.hits.map(hit => hit._source.global_sequence)); after = result.hits.hits.at(-1).sort;
                    assert.equal(typeof after[0], 'string'); assert.equal(after[0].length, 20);
                    assert(cursor.length <= selected.length, 'Non-progressing production PIT cursor');
                } while (true);
                assert.deepEqual(cursor, selected);
            } finally {await context.close();}
        }
    });
    await check('production source projection restores metadata privately and keeps arbitrary contract values unchanged', async () => {
        const result = await adapter.search(index, {query: {term: {global_sequence: '18446744073709551615'}},
            _source: {includes: ['global_sequence', 'code_sequence', 'receipts.recv_sequence', 'act.data']}});
        assert.deepEqual(result.hits.hits[0]._source, {global_sequence: '18446744073709551615', code_sequence: 4294967295,
            receipts: [{recv_sequence: '18446744073709551615'}, {recv_sequence: '9223372036854775809'}], act: {data: source.at(-1).act.data}});
        const nativeLegacy = await client.search({index, query: {term: {global_sequence: '1'}}, _source: {includes: ['global_sequence', 'receipts.recv_sequence']}});
        const projected = await adapter.search(index, {query: {term: {global_sequence: '1'}}, _source: {includes: ['global_sequence', 'receipts.recv_sequence']}});
        assert.deepEqual(projected.hits.hits[0]._source, {...nativeLegacy.hits.hits[0]._source, global_sequence: '1'});
        const sourceFilter = {includes: ['act.*'], excludes: ['*.exact_contract_string']};
        const nativeProjection = await client.search({index, query: {ids: {values: ['18446744073709551615']}}, _source: sourceFilter});
        const logicalProjection = await adapter.search(index, {query: {term: {global_sequence: '18446744073709551615'}}, _source: sourceFilter});
        assert.deepEqual(logicalProjection.hits.hits[0]._source, nativeProjection.hits.hits[0]._source);
    });
    await check('production coverage refuses a lost contract row and preserves taint after its last unsafe survivor is overwritten', async () => {
        const bad = `${chain}-action-v1-000003`;
        await client.indices.create({index: bad, settings: legacySettings, mappings: {dynamic: 'strict', properties: legacyProperties}});
        await ensureActionSequenceMappings(client, chain);
        identity.set(bad, (await client.indices.getSettings({index: bad, flat_settings: true}))[bad].settings['index.uuid']);
        const originals = ['9007199254740992', '9007199254740993'].map((sequence, position) => logical(sequence, position ? 'survivor' : 'lost'));
        for (const action of originals) await client.index({index: bad, id: String(Number(action.global_sequence)),
            document: {...action, global_sequence: Number(action.global_sequence)}, refresh: true});
        assert.equal((await client.count({index: bad, query: {term: {category: 'lost'}}})).count, 0);
        incomplete.add(bad);
        await assert.rejects(adapter.search(bad, {query: {term: {category: 'lost'}}}), error => error.statusCode === 503);
        await client.index({index: bad, id: originals[0].global_sequence, document: encodeActionSequenceStorage(originals[0]), refresh: true});
        assert.equal((await client.count({index: bad, query: unknownCoverage({match_all: {}})})).count, 0);
        await assert.rejects(adapter.search(bad, {query: {term: {category: 'survivor'}}}), error => error.statusCode === 503);
        // Independently certified concrete partitions remain available.
        assert.equal(total(await adapter.search(index, {size: 0, track_total_hits: true})), source.length);
        return {lostContractRawCount: 0, adapterStatus: 503, zeroUnsafeSurvivorsStillIncomplete: true,
            unrelatedConcretePartitionAvailable: true, noSourceReplayClaim: true};
    });
    await check('production generation and cancellation fences release native PIT memory', async () => {
        const context = await adapter.open(index); generation++;
        try {await assert.rejects(context.count(), error => error.statusCode === 503);} finally {await context.close();}
        const controller = new AbortController(), cancelled = await adapter.open(index, {signal: controller.signal});
        const request = cancelled.search({}); controller.abort();
        try {await assert.rejects(request, error => error.statusCode === 503);} finally {await cancelled.close();}
        assert.equal(leases, releases);
        const stats = await client.nodes.stats({index_metric: ['search'], metric: ['indices']});
        assert(Object.values(stats.nodes).every(node => node.indices.search.open_contexts === 0));
        return {leases, releases, openContexts: 0, scope: 'Cancellation and stale generation mechanics, not recovery latency profiling'};
    });
    await check('production writable-source guard rejects destructive source pruning before any namespace write', async () => {
        const unsafeChain = `${parentChain}-pruned`, unsafeIndex = `${unsafeChain}-action-v1-000001`;
        await client.indices.create({index: unsafeIndex, settings: legacySettings,
            mappings: {_source: {excludes: ['receipts']}, properties: legacyProperties}});
        await assert.rejects(ensureActionSequenceMappings(client, unsafeChain), /stored _source retention/);
        assert.equal((await client.indices.getMapping({index: unsafeIndex}))[unsafeIndex].mappings.properties[prefix], undefined);
    });
    report.qualification.productionModules = true;
}

try {
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    report.versions = Object.fromEntries(['@elastic/elasticsearch', '@elastic/transport'].map(packageName =>
        [packageName, lock.packages[`node_modules/${packageName}`].version]));
    assert.equal(report.versions['@elastic/elasticsearch'], '8.19.1'); assert.equal(report.versions['@elastic/transport'], '8.10.1');
    report.source = {scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
        gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', timeout: 10000}).trim()};
    await check('installed default serializer rounds numeric sequence sorts and preserves strings', () => {
        const serializer = new Serializer();
        const result = serializer.deserialize('{"sort":[9007199254740993,"00009007199254740993"],"value":"9007199254740993"}');
        assert.equal(String(result.sort[0]), '9007199254740992'); assert.equal(result.sort[1], '00009007199254740993');
        assert.equal(result.value, '9007199254740993');
        return result;
    });
    networkId = docker(['network', 'create', ...labels('network'), network]); assert.match(networkId, /^[a-f0-9]{64}$/);
    const networkState = JSON.parse(docker(['network', 'inspect', networkId]))[0]; owned(networkState, 'network');
    assert.equal(networkState.Id, networkId); assert.equal(networkState.Name, network);
    const server = await launch('server'), client = server.client; report.server = server.server;
    const chain = `hyp-seq-${run}`, indices = [1, 2, 3].map(part => `${chain}-action-v1-${String(part).padStart(6, '0')}`);
    const alias = `${chain}-action-read`;
    await check('old signed-long index sort is preserved when the strict namespace is added', async () => {
        for (const index of indices) await client.indices.create({index, settings: legacySettings,
            mappings: {dynamic: 'strict', _meta: {hyperion_sequence_fixture_owner: run}, properties: legacyProperties}, aliases: {[alias]: {}}});
        const retained = logical('1'); retained.global_sequence = 1;
        await client.index({index: indices[0], id: '1', document: retained, refresh: true, wait_for_active_shards: 'all'});
        const before = (await client.indices.getSettings({index: indices[0], flat_settings: true}))[indices[0]].settings;
        for (const index of indices) {
            const receipt = await client.indices.putMapping({index, properties: {[prefix]: sequenceMapping()}}); assert.equal(receipt.acknowledged, true);
            const actual = (await client.indices.getMapping({index}))[index].mappings.properties[prefix];
            assert.equal(actual.dynamic, 'strict'); assert.equal(actual.properties.global.properties.value.type, 'unsigned_long');
            assert.equal(actual.properties.global.properties.key.type, 'keyword');
        }
        assert.deepEqual((await client.get({index: indices[0], id: '1'}))._source, retained);
        const after = (await client.indices.getSettings({index: indices[0], flat_settings: true}))[indices[0]].settings;
        assert.deepEqual(after, before); assert.equal(after['index.sort.field'], 'global_sequence');
        report.effective = {settings: after, mapping: (await client.indices.getMapping({index: indices[0]}))[indices[0]].mappings,
            limitations: 'Selected production scalar fields and four primaries; zero replicas in this one-node design fixture, not the complete production plugin template'};
    });
    const safeOld = ['9', '10', '9007199254740991'];
    const exactNew = ['2', '8', '11', '9007199254740992', '9007199254740993', '9223372036854775806',
        '9223372036854775807', '9223372036854775808', '9223372036854775809', '18446744073709551614', '18446744073709551615'];
    const expected = ['1', ...safeOld, ...exactNew].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    await check('full uint64 writes omit only incompatible old copies and keep uint32 counters numeric', async () => {
        const operations = [];
        for (const sequence of safeOld) {
            const document = logical(sequence); document.global_sequence = Number(sequence);
            operations.push({index: {_index: indices[0], _id: sequence}}, document);
        }
        for (const [position, sequence] of exactNew.entries()) {
            const metadata = [2147483647, 2147483648, 4294967295][position % 3];
            operations.push({index: {_index: indices[position % 2], _id: sequence}}, physical(logical(sequence, 'covered', position + 2, metadata)));
        }
        const result = await client.bulk({operations, refresh: true, wait_for_active_shards: 'all'});
        assert.equal(result.errors, false); assert.equal(result.items.length, safeOld.length + exactNew.length);
        for (const item of result.items) {
            assert([200, 201].includes(item.index.status)); assert.equal(item.index._shards.failed, 0); assert(item.index._shards.successful >= 1);
        }
        for (const [position, sequence] of exactNew.entries()) {
            const source = (await client.get({index: indices[position % 2], id: sequence}))._source;
            assert.equal(source[prefix].global.value, sequence); assert.equal(source[prefix].global.key, sequence.padStart(20, '0'));
            assert.equal(typeof source[prefix].code_sequence, 'number'); assert.equal(typeof source[prefix].abi_sequence, 'number');
            if (BigInt(sequence) > signedMaximum) {
                assert.equal(Object.hasOwn(source, 'global_sequence'), false);
                assert.equal(Object.hasOwn(source.receipts[0], 'global_sequence'), false);
                assert.equal(Object.hasOwn(source.receipts[0], 'recv_sequence'), false);
                assert.equal(Object.hasOwn(source.receipts[0].auth_sequence[0], 'sequence'), false);
            } else assert.equal(source.global_sequence, sequence);
            if (source[prefix].code_sequence > signedIntegerMaximum) {
                assert.equal(Object.hasOwn(source, 'code_sequence'), false); assert.equal(Object.hasOwn(source, 'abi_sequence'), false);
            }
        }
        return {acceptedItems: result.items.length, exactRows: expected.length};
    });
    await check('fixture alone disables expensive queries with effective read-back', async () => {
        const receipt = await client.cluster.putSettings({persistent: {'search.allow_expensive_queries': false}}); assert.equal(receipt.acknowledged, true);
        const effective = await client.cluster.getSettings({flat_settings: true}); assert.equal(effective.persistent['search.allow_expensive_queries'], 'false');
        report.expensiveQueries = {requested: false, effective: effective.persistent['search.allow_expensive_queries'], ownedClusterOnly: true};
    });
    await check('native unsigned-long sort exposes numeric rounding while the exact source stays text', async () => {
        const request = {size: 1, query: {term: {[valueField]: '9007199254740993'}}, sort: {[valueField]: 'asc'}, track_total_hits: true};
        const result = complete(await client.search({index: alias, ...request})); assert.equal(total(result), 1);
        const hit = result.hits.hits[0]; assert.equal(hit._source[prefix].global.value, '9007199254740993');
        assert.equal(typeof hit.sort[0], 'number'); assert.equal(String(hit.sort[0]), '9007199254740992');
        const rawResponse = await fetch(`${server.url}/${alias}/_search`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(request)});
        assert.equal(rawResponse.status, 200); const raw = await rawResponse.text(); assert.match(raw, /"sort"\s*:\s*\[9007199254740993\]/);
        return {rawSort: '9007199254740993', parsedSort: String(hit.sort[0]), source: hit._source[prefix].global.value};
    });
    await check('native range predicates, exclusion and totals use one cohort OR before pagination', async () => {
        const tests = [
            {name: 'exact neighbor', entries: [{op: 'eq', value: '9007199254740993'}], matches: value => value === 9007199254740993n},
            {name: 'inclusive boundaries', entries: [{op: 'range', bounds: {gte: '9007199254740992', lte: '9223372036854775808'}}], matches: value => value >= 9007199254740992n && value <= 9223372036854775808n},
            {name: 'exclusive boundaries', entries: [{op: 'range', bounds: {gt: '9007199254740992', lt: '9223372036854775808'}}], matches: value => value > 9007199254740992n && value < 9223372036854775808n},
            {name: 'whole-cohort conjunction', entries: [{op: 'range', bounds: {gte: '9'}}, {op: 'ne', value: '10'}], matches: value => value >= 9n && value !== 10n},
            {name: 'mixed terms', entries: [{op: 'in', values: ['1', '9007199254740993', '18446744073709551615']}], matches: value => [1n, 9007199254740993n, maximum].includes(value)},
            {name: 'upper bound clipped for legacy long', entries: [{op: 'range', bounds: {lte: '18446744073709551615'}}], matches: () => true},
            {name: 'empty beyond maximum', entries: [{op: 'range', bounds: {gt: '18446744073709551615'}}], matches: () => false}
        ];
        const state = await openPit(client, alias);
        try {
            for (const entry of tests) {
                const selected = expected.filter(value => entry.matches(BigInt(value)));
                const response = await pitSearch(state, covered, entry.entries);
                assert.deepEqual(response.hits.hits.map(sequenceOf), selected, entry.name); assert.equal(total(response), selected.length, entry.name);
                const count = await client.count({index: alias, query: query(covered, entry.entries)});
                assert.equal(count._shards.failed, 0); assert.equal(count.count, selected.length, entry.name);
            }
        } finally {await closePit(state);}
        return {predicateCases: tests.length};
    });
    await check('mixed old/new offset pages and PIT search_after preserve exact one-query order', async () => {
        for (const order of ['asc', 'desc']) {
            const selected = order === 'asc' ? expected : [...expected].reverse();
            const state = await openPit(client, `${chain}-action-v1-*`);
            try {
                const offsets = [];
                for (let from = 0; from < selected.length; from += 3) {
                    const response = await pitSearch(state, covered, [], {order, from, size: 3});
                    offsets.push(...response.hits.hits.map(sequenceOf)); assert.equal(total(response), expected.length);
                }
                assert.deepEqual(offsets, selected);
                const resumed = []; let after;
                while (true) {
                    const response = await pitSearch(state, covered, [], {order, size: 3, after});
                    if (!response.hits.hits.length) break;
                    resumed.push(...response.hits.hits.map(sequenceOf)); after = response.hits.hits.at(-1).sort;
                    assert(resumed.length <= expected.length, 'Repeated or non-progressing PIT page');
                }
                assert.deepEqual(resumed, selected); assert.equal(new Set(resumed).size, selected.length);
            } finally {await closePit(state);}
        }
    });
    await check('prototype category-filtered probe freezes its snapshot; it is not a missing-row coverage proof', async () => {
        const unsafe = logical('9007199254740993', 'incomplete'); unsafe.global_sequence = Number(unsafe.global_sequence);
        await client.index({index: indices[2], id: 'unknown-unsafe', document: unsafe, refresh: true});
        const snapshot = await openPit(client, alias);
        try {
            assert.deepEqual((await pitSearch(snapshot)).hits.hits.map(sequenceOf), expected);
            await assert.rejects(pitSearch(snapshot, {terms: {category: ['covered', 'incomplete']}}),
                error => error.code === 'ACTION_SEQUENCE_COVERAGE_UNAVAILABLE' && error.statusCode === 503);
            const late = logical('9007199254740993'); late.global_sequence = Number(late.global_sequence);
            await client.index({index: indices[2], id: 'late-unsafe', document: late, refresh: true});
            assert.deepEqual((await pitSearch(snapshot)).hits.hits.map(sequenceOf), expected, 'Old PIT must retain its covered snapshot');
            const changed = await openPit(client, alias);
            try {await assert.rejects(pitSearch(changed), error => error.code === 'ACTION_SEQUENCE_COVERAGE_UNAVAILABLE');}
            finally {await closePit(changed);}
            await client.delete({index: indices[2], id: 'late-unsafe', refresh: true});
        } finally {await closePit(snapshot);}
        return {unrelatedCoveredScopeAvailable: true, affectedScopeStatus: 503, samePitRaceControlled: true};
    });
    await check('keyword ranges, runtime queries and script queries remain rejected with expensive queries disabled', async () => {
        const keyword = await rejection(() => client.search({index: alias, query: {range: {[keyField]: {gt: '00000000000000000009'}}}}), /allow_expensive_queries/);
        const runtime = await rejection(() => client.search({index: alias, runtime_mappings: {virtual_key: {type: 'keyword', script: {source: "emit('x')"}}},
            query: {term: {virtual_key: 'x'}}}), /allow_expensive_queries/);
        const script = await rejection(() => client.search({index: alias, query: {script: {script: {source: 'true'}}}}), /allow_expensive_queries/);
        return {keyword, runtime, script};
    });
    await check('old rounded document IDs can overwrite neighboring original actions', async () => {
        const collisionIndex = `${chain}-legacy-collision`;
        await client.indices.create({index: collisionIndex, settings: legacySettings, mappings: {dynamic: 'strict', properties: legacyProperties}});
        const originals = ['9007199254740992', '9007199254740993']; const ids = originals.map(value => String(Number(value)));
        assert.equal(ids[0], ids[1]);
        const outcomes = [];
        for (const sequence of originals) {
            const document = logical(sequence); document.global_sequence = Number(sequence);
            outcomes.push((await client.index({index: collisionIndex, id: String(document.global_sequence), document, refresh: true})).result);
        }
        assert.deepEqual(outcomes, ['created', 'updated']); assert.equal((await client.count({index: collisionIndex})).count, 1);
        const retained = (await client.get({index: collisionIndex, id: ids[0]}))._source;
        assert.equal(retained.receipts[0].global_sequence, originals[1]);
        return {originals, indexedIds: ids, outcomes, remainingRows: 1,
            limitation: 'Retained receipt can identify the surviving row; it cannot recreate the overwritten row'};
    });
    await check('uint64-derived action_count uses exact subtraction and always decimal text', () => {
        const result = String(BigInt(decimal('9007199254740993')) - BigInt(decimal('9007199254740992')));
        assert.equal(result, '1'); assert.equal(String(0n), '0');
        return {action_count: result, scope: 'Arithmetic contract only; HTTP serializer/cache integration remains unqualified'};
    });
    await qualifyProductionModules(client, chain);
    await check('the main server releases all PIT contexts before shutdown', async () => {
        assert.equal(pits.size, 0);
        const stats = await client.nodes.stats({metric: ['indices', 'jvm', 'process'], index_metric: ['search', 'store', 'segments', 'merge', 'refresh']});
        const nodes = Object.values(stats.nodes); assert.equal(nodes.length, 1);
        const node = nodes[0]; assert.equal(node.indices.search.open_contexts, 0);
        report.observations.resources = {indices: node.indices, heapUsedBytes: node.jvm.mem.heap_used_in_bytes,
            processCpuPercent: node.process.cpu.percent,
            limitation: 'Single small scalar fixture; descriptive counters and case wall time are not component profiling or a performance comparison'};
    });
    await client.close(); clients.delete(client);
    const mainOwned = JSON.parse(docker(['inspect', server.id]))[0]; owned(mainOwned, 'server'); assert.equal(mainOwned.Id, server.id);
    docker(['stop', '-t', '10', server.id]);
    await check('disabled string-sort context gives an explicit native capability failure', async () => {
        const denied = await launch('scripts-denied', true); report.scriptContextServer = denied.server;
        const chain = `hyp-script-capability-${run}`, index = `${chain}-action-v1-000001`;
        await denied.client.indices.create({index, mappings: {properties: {global_sequence: {type: 'long'}}}});
        await denied.client.index({index, id: '1', document: {global_sequence: 1}, refresh: true});
        const native = await rejection(() => denied.client.search({index, sort: [mixedSort('asc')]}), /cannot execute scripts using \[string_sort\] context/);
        const {ActionHistoryAdapter} = await import('../../build/indexer/history/action-history-adapter.js');
        const adapter = new ActionHistoryAdapter(denied.client, chain, {async acquire(snapshot) {
            return {generation: 'owned-script-capability-fixture', source: 'owned-fixture:one-safe-original', indices: snapshot.indices,
                async assertComplete() {}, async assertCurrent() {}, async release() {}};
        }});
        await assert.rejects(adapter.search(index, {sort: {global_sequence: 'asc'}}), error => error.statusCode === 503);
        const stats = await denied.client.nodes.stats({metric: ['indices'], index_metric: ['search']});
        assert(Object.values(stats.nodes).every(node => node.indices.search.open_contexts === 0));
        return {...native, adapterStatus: 503, openContexts: 0};
    });
    report.status = 'passed';
} catch (error) {
    report.status = 'failed'; report.error = String(error.stack ?? error);
} finally {
    for (const state of [...pits]) {
        try {await closePit(state);} catch (error) {report.status = 'failed'; (report.cleanup.pitErrors ??= []).push(String(error.stack ?? error));}
    }
    for (const client of clients) {
        try {await client.close();} catch (error) {report.status = 'failed'; (report.cleanup.clientErrors ??= []).push(String(error.stack ?? error));}
    }
    for (const state of containers.values()) {
        const receipt = {name: state.name, role: state.role, removed: false, verified: false};
        try {
            // Recover a created container even if docker run lost its response.
            const inventory = docker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${state.name}$`]).split('\n').filter(Boolean);
            assert(inventory.length <= 1);
            if (inventory.length) {
                const inspected = JSON.parse(docker(['inspect', inventory[0]]))[0]; owned(inspected, state.role);
                assert.equal(inspected.Name, '/' + state.name); assert.equal(inspected.Id, inventory[0]);
                if (state.id) assert.equal(inspected.Id, state.id); assert.equal(inspected.Config.Image, image);
                docker(['rm', '-f', '-v', inspected.Id]); receipt.removed = true;
            }
            assert.equal(docker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${state.name}$`]), '');
            receipt.verified = true;
        } catch (error) {report.status = 'failed'; receipt.error = String(error.stack ?? error);}
        report.cleanup.containers.push(receipt);
    }
    try {
        // Inspect by the generated exact name after partial network creation too.
        const inventory = docker(['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
        assert(inventory.length <= 1);
        if (inventory.length) {
            const inspected = JSON.parse(docker(['network', 'inspect', network]))[0]; owned(inspected, 'network');
            assert.equal(inspected.Name, network); if (networkId) assert.equal(inspected.Id, networkId);
            assert.equal(Object.keys(inspected.Containers ?? {}).length, 0); docker(['network', 'rm', inspected.Id]);
        }
        assert.equal(docker(['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.ID}}']), '');
        report.cleanup.network = true;
    } catch (error) {report.status = 'failed'; report.cleanup.networkError = String(error.stack ?? error);}
    report.cleanup.verified = report.cleanup.network && report.cleanup.containers.every(value => value.verified)
        && !report.cleanup.pitErrors && !report.cleanup.clientErrors;
    if (!report.cleanup.verified) report.status = 'failed';
    report.completedAt = new Date().toISOString();
    try {
        const text = JSON.stringify(report, null, 2) + '\n'; if (output) writeFileSync(output, text); process.stdout.write(text);
        if (report.status !== 'passed') process.exitCode = 1;
    } finally {clearInterval(keepAlive);}
}
