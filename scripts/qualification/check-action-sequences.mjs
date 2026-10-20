import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
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
    purpose: 'Native storage/query design prototype; not production adapter or release qualification',
    qualification: {productionAdapter: false, retainedHistoryUpgrade: false, abiProof: false, wireTestnet: false, release: false},
    runtime: {node: process.versions.node, bun: process.versions.bun ?? null},
    checks: [], observations: {}, cleanup: {containers: [], network: false, verified: false}};
const containers = new Map(), clients = new Set(), pits = new Set();
let networkId;

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
    state.client = new Client({node: state.url, requestTimeout: 10000, maxRetries: 0}); clients.add(state.client);
    let info, lastError;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
        try {info = await state.client.info(); break;} catch (error) {lastError = error; await sleep(250);}
    }
    assert.equal(info?.version?.number, '9.5.5', `Owned server did not start: ${lastError?.message ?? 'no response'}`);
    assert.equal(info.cluster_name, `${clusterName}-${role}`); assert.match(info.cluster_uuid, /^[A-Za-z0-9_-]{16,64}$/);
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
        assert.deepEqual(after, before); assert.deepEqual(after['index.sort.field'], ['global_sequence']);
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
    await check('PIT coverage refuses only affected unsafe legacy scopes and freezes the check with the search', async () => {
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
    await check('the main server releases all PIT contexts before shutdown', async () => {
        assert.equal(pits.size, 0);
        const stats = await client.nodes.stats({metric: ['indices', 'jvm', 'process'], index_metric: ['search', 'store', 'segments', 'merges', 'refresh']});
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
        const index = `hyp-script-capability-${run}`;
        await denied.client.indices.create({index, mappings: {properties: {global_sequence: {type: 'long'}}}});
        await denied.client.index({index, id: '1', document: {global_sequence: 1}, refresh: true});
        return await rejection(() => denied.client.search({index, sort: [mixedSort('asc')]}), /cannot execute scripts using \[string_sort\] context/);
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
    const text = JSON.stringify(report, null, 2) + '\n'; if (output) writeFileSync(output, text); process.stdout.write(text);
    if (report.status !== 'passed') process.exitCode = 1;
}
