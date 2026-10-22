import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@elastic/elasticsearch';

// This component fixture accepts no borrowed URL, credentials, image override,
// operator namespace or live cluster settings. All mutations stay in this run.
const image = 'docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c';
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const qualifier = 'action-source-journal';
const stem = `hyp-action-journal-${run}`, network = `${stem}-net`, clusterName = `${stem}-cluster`;
const output = process.argv[2];
if (process.argv.length > 3) throw new Error('Usage: node check-action-source-journal.mjs [output.json]');
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const docker = args => execFileSync('docker', args, {encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024}).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inspect = (id, timeout = 10000) => JSON.parse(execFileSync('docker', ['inspect', id],
    {encoding: 'utf8', timeout, maxBuffer: 256 * 1024, windowsHide: true}))[0];
const clients = new Set(), containers = new Map();
let networkId, client, fixtureChain;
// The pinned transport can leave only unreferenced handles during a request.
// Keep owned-resource cleanup alive, including startup and failure paths.
const keepAlive = setInterval(() => {}, 1000);
const report = {schemaVersion: 1, status: 'running', createdAt: new Date().toISOString(), run, image,
    purpose: 'Expected source-membership journal and private confirmed-handoff outcome storage component qualification',
    runtime: {node: process.versions.node, bun: process.versions.bun ?? null},
    qualification: {sourceJournal: false, confirmedHandoffOutcomes: false, realTwoCopyWrites: false, replicaPeerRecovery: false,
        sourceCapture: false, productionFanout: false, sinkEffects: false, canonicalRecovery: false,
        pitCoverageAuthority: false, retainedHistoryUpgrade: false, wireTestnet: false, release: false},
    checks: [], observations: {}, cleanup: {containers: [], network: false, runnerOpenedPits: 0,
        openSearchContextsBeforeRemoval: null, verified: false}};

function labels(role) {
    return ['--label', `io.eosrio.qualifier=${qualifier}`, '--label', `io.eosrio.run=${run}`,
        '--label', `io.eosrio.role=${role}`];
}

function owned(value, role) {
    const values = value.Config?.Labels ?? value.Labels;
    assert.equal(values?.['io.eosrio.qualifier'], qualifier, 'Refuse a foreign qualifier');
    assert.equal(values?.['io.eosrio.run'], run, 'Refuse a foreign run');
    assert.equal(values?.['io.eosrio.role'], role, 'Refuse a foreign fixture role');
}

function verifyContainer(state, {portMayBePending = false, inspectionTimeoutMs = 10000} = {}) {
    delete state.url;
    const value = inspect(state.id, inspectionTimeoutMs); owned(value, state.role);
    assert.equal(value.Id, state.id); assert.equal(value.Name, '/' + state.name); assert.equal(value.Config.Image, image);
    assert.equal(value.HostConfig.NanoCpus, 2_000_000_000); assert.equal(value.HostConfig.Memory, 2 * 1024 ** 3);
    assert.match(value.HostConfig.Tmpfs?.['/usr/share/elasticsearch/data'] ?? '', /size=268435456/);
    assert.equal(value.HostConfig.Binds?.length ?? 0, 0);
    assert.equal(value.HostConfig.NetworkMode, network);
    const configured = value.HostConfig.PortBindings?.['9200/tcp'];
    assert.equal(configured?.length, 1); assert.equal(configured[0].HostIp, '127.0.0.1');
    const requestedPort = configured[0].HostPort;
    assert(requestedPort === '' || requestedPort === '0' ||
        (/^[0-9]+$/.test(requestedPort) && Number(requestedPort) > 1024 && Number(requestedPort) <= 65535 && Number(requestedPort) !== 9200));
    const networks = Object.keys(value.NetworkSettings.Networks ?? {});
    assert(networks.every(name => name === network), 'Refuse an unexpected container network');
    const phase = value.State?.Status;
    assert(!value.State?.Dead && !value.State?.OOMKilled && !value.State?.Paused &&
        !['exited', 'dead', 'removing'].includes(phase),
    `Owned container cannot become ready: ${phase ?? 'unknown'} (exit ${value.State?.ExitCode ?? 'unknown'})`);
    const ports = value.NetworkSettings.Ports?.['9200/tcp'];
    if (portMayBePending && (ports === null || ports === undefined || ports.length === 0)) return value;
    assert.equal(ports?.length, 1); assert.equal(ports[0].HostIp, '127.0.0.1');
    const port = Number(ports[0].HostPort);
    assert(Number.isInteger(port) && port > 1024 && port <= 65535 && port !== 9200);
    if (portMayBePending && (networks.length === 0 || value.State?.Running !== true)) return value;
    assert.equal(networks.length, 1); assert.equal(value.State?.Running, true);
    state.url = `http://127.0.0.1:${port}`;
    return value;
}

async function waitForContainerPort(state, maximumWaitMs = 30000) {
    const deadline = performance.now() + maximumWaitMs;
    const expired = cause => new Error(`Owned container did not publish its loopback port within ${maximumWaitMs}ms: ${state.name}`, {cause});
    for (;;) {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) throw expired();
        let value;
        try {value = verifyContainer(state, {portMayBePending: true, inspectionTimeoutMs: Math.min(10000, remaining)});}
        catch (error) {
            if (error.code === 'ETIMEDOUT' && performance.now() >= deadline) throw expired(error);
            throw error;
        }
        if (state.url) return value;
        if (performance.now() >= deadline) throw expired();
        await sleep(Math.min(100, Math.max(1, deadline - performance.now())));
    }
}

function launch(role) {
    const state = {role, name: `${stem}-${role}`}; containers.set(state.name, state);
    const primary = `${stem}-primary`;
    state.id = docker(['run', '-d', '--name', state.name, '--network', network, ...labels(role),
        '--cpus', '2', '--memory', '2g', '-p', '127.0.0.1::9200',
        '--tmpfs', '/usr/share/elasticsearch/data:rw,uid=1000,gid=0,size=268435456',
        '-e', `cluster.name=${clusterName}`, '-e', `node.name=${state.name}`,
        '-e', `node.roles=${role === 'primary' ? 'master,data,ingest' : 'data,ingest'}`,
        '-e', `discovery.seed_hosts=${primary}:9300`,
        ...(role === 'primary' ? ['-e', `cluster.initial_master_nodes=${primary}`] : []),
        '-e', 'network.host=0.0.0.0', '-e', 'xpack.security.enabled=false',
        '-e', 'xpack.security.autoconfiguration.enabled=false', '-e', 'xpack.ml.enabled=false',
        '-e', 'ingest.geoip.downloader.enabled=false', '-e', 'ES_JAVA_OPTS=-Xms512m -Xmx512m', image]);
    assert.match(state.id, /^[a-f0-9]{64}$/); verifyContainer(state, {portMayBePending: true});
    return state;
}

async function connect(state) {
    await waitForContainerPort(state);
    const deadline = Date.now() + 90000;
    let info, lastError;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(state.url, {signal: AbortSignal.timeout(2000)});
            if (response.ok) {
                const candidate = await response.json();
                assert.equal(candidate.version?.number, '9.5.5'); assert.equal(candidate.cluster_name, clusterName);
                if (/^[A-Za-z0-9_-]{16,64}$/.test(candidate.cluster_uuid ?? '')) {info = candidate; break;}
                lastError = new Error('Owned node has not joined its named cluster yet');
            } else lastError = new Error(`Owned startup HTTP status ${response.status}`);
        } catch (error) {lastError = error;}
        await sleep(250);
    }
    assert.equal(info?.version?.number, '9.5.5', `Owned server startup: ${lastError?.message ?? 'no response'}`);
    assert.equal(info.cluster_name, clusterName);
    assert.match(info.cluster_uuid, /^[A-Za-z0-9_-]{16,64}$/);
    state.client = new Client({node: state.url, requestTimeout: 10000, maxRetries: 0}); clients.add(state.client);
    const observed = await state.client.info(); assert.equal(observed.cluster_uuid, info.cluster_uuid);
    state.server = {version: info.version.number, clusterName, clusterUuid: info.cluster_uuid, url: state.url};
    return state.client;
}

function captureFailureDiagnostics(state) {
    const diagnostic = {name: state.name, id: state.id ?? null};
    try {
        const value = inspect(state.id ?? state.name); owned(value, state.role);
        assert.equal(value.Name, '/' + state.name); assert.equal(value.Config.Image, image);
        if (state.id) assert.equal(value.Id, state.id);
        diagnostic.id = value.Id;
        diagnostic.state = Object.fromEntries(['Status', 'Running', 'Paused', 'Restarting', 'OOMKilled', 'Dead', 'ExitCode',
            'StartedAt', 'FinishedAt'].map(key => [key, value.State?.[key]]));
        diagnostic.stateError = String(value.State?.Error ?? '').slice(0, 4096);
        diagnostic.configuredBindings = value.HostConfig.PortBindings?.['9200/tcp'] ?? null;
        diagnostic.publishedBindings = value.NetworkSettings.Ports?.['9200/tcp'] ?? null;
        diagnostic.networks = Object.keys(value.NetworkSettings.Networks ?? {});
        const result = spawnSync('docker', ['logs', '--tail', '80', '--timestamps', value.Id],
            {encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true});
        const bounded = text => Buffer.from(String(text ?? '')).subarray(-16 * 1024).toString('utf8');
        diagnostic.stdoutTail = bounded(result.stdout); diagnostic.stderrTail = bounded(result.stderr);
        diagnostic.logExitCode = result.status;
        if (result.error) diagnostic.logReadError = bounded(result.error.message);
    } catch (error) {diagnostic.observationError = String(error.stack ?? error).slice(0, 4096);}
    return diagnostic;
}

async function check(name, action) {
    const started = process.hrtime.bigint();
    try {
        const details = await action();
        report.checks.push({name, status: 'passed', elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
            ...(details === undefined ? {} : {details})});
    } catch (error) {
        report.checks.push({name, status: 'failed', elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
            error: String(error.stack ?? error)});
        throw error;
    }
}

function instrument(base, expectedIndex, options = {}) {
    const state = {writes: [], reads: [], durableReceipts: [], calls: []};
    const proxy = new Proxy(base, {get(target, key) {
        if (key === 'create' || key === 'index') return async (request, transport) => {
            assert.equal(request.index, expectedIndex, 'Fault wrapper cannot mutate another index');
            const write = {method: key, request: structuredClone(request)}; state.writes.push(write); state.calls.push(write);
            await options.beforeWrite?.(write);
            const response = await target[key](request, transport);
            // Validate the real server receipt BEFORE an explicitly simulated response fault.
            assert.equal(response._index, expectedIndex); assert.equal(response._id, request.id);
            assert.equal(response._shards?.total, 2); assert.equal(response._shards?.successful, 2);
            assert.equal(response._shards?.failed, 0);
            state.durableReceipts.push({id: response._id, seqNo: response._seq_no, primaryTerm: response._primary_term,
                total: response._shards.total, successful: response._shards.successful, failed: response._shards.failed});
            return options.afterWrite ? options.afterWrite(write, response) : response;
        };
        if (key === 'get') return async (request, transport) => {
            assert.equal(request.index, expectedIndex); state.reads.push(structuredClone(request));
            return target.get(request, transport);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
    }});
    return {client: proxy, state};
}

function sourcePlan(number, transactions = 4, targetChain = fixtureChain) {
    const hex = value => value.toString(16).padStart(64, '0');
    return {schemaVersion: 1,
        source: {chainId: '1'.repeat(64), blockNum: number, blockId: hex(number), previousBlockId: hex(number - 1),
            captureSha256: sha256(`constructed-journal-record:${number}`)},
        producer: {protocolId: 'journal-component-fixture', profileId: 'constructed-records-v1',
            codeRevision: report.source.gitHead, configurationSha256: '2'.repeat(64), pluginsSha256: '3'.repeat(64)},
        // Inert metadata only: this runner does not create/write an action sink or certify its UUID.
        target: {name: `${targetChain}-action-v1-000001`, uuid: 'constructed-target-identity-v1'},
        transactions: Array.from({length: transactions}, (_, index) => ({transactionId: hex(number * 100000 + index + 1),
            traceOrdinal: index, traceSha256: sha256(`constructed-trace:${number}:${index}`),
            disposition: index === 2 ? 'excluded' : index === 3 ? 'no-effects' : 'process'}))};
}

function logical(plan, transactionId, sequence, data = {}) {
    return {global_sequence: sequence, block_num: plan.source.blockNum, block_id: plan.source.blockId, trx_id: transactionId,
        '@timestamp': '2026-10-20T00:00:00.000Z', act: {account: 'alpha', name: 'fixture', authorization: [],
            data: {global_sequence: '0001', fraction: 1.25, exponent: 1e-30, largeFinite: 1e100, negativeZero: -0, ...data}},
        code_sequence: 0xffffffff, abi_sequence: 0xffffffff,
        receipts: [{receiver: 'alpha', global_sequence: sequence, recv_sequence: '18446744073709551615',
            auth_sequence: [{account: 'alice', sequence: '9223372036854775808'}, {account: 'bob', sequence: '0'}]}]};
}

function isReadFailure(code) {return error => error?.name === 'ActionHistorySourceJournalReadError' && error.code === code;}
const aborted = error => error?.name === 'AbortError' || /abort/i.test(String(error?.message));

function installedVersion(packageName) {
    let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));
    for (let level = 0; level < 5; level++) {
        const path = join(directory, 'package.json');
        if (existsSync(path)) {
            const metadata = JSON.parse(readFileSync(path, 'utf8'));
            if (metadata.name === packageName) return metadata.version;
        }
        directory = dirname(directory);
    }
    throw new Error(`Installed package metadata was not found for ${packageName}`);
}

// ConfigurationModule reads process configuration at import time. Isolate those
// imports in a child with constructed files, never the operator's configuration.
// Capture the actual master-built template, including its read-alias policy.
function productionActionTemplate(chain) {
    const parent = resolve(tmpdir()), prefix = 'hyperion-journal-template-';
    const directory = mkdtempSync(join(parent, prefix));
    try {
        mkdirSync(join(directory, 'config'));
        writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain, debug: false,
            eosio_alias: 'eosio', parser: '3.2', es_replicas: 1, use_read_aliases: true},
        indexer: {}, features: {}, scaling: {}, api: {}, whitelists: {actions: [], deltas: []}}));
        writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({
            amqp: {protocol: 'http'}, elasticsearch: {host: '127.0.0.1:1', user: '', pass: ''},
            chains: {[chain]: {chain_id: '1'.repeat(64), http: 'http://127.0.0.1:1', ship: 'ws://127.0.0.1:1'}},
            redis: {host: '127.0.0.1', port: 1}
        }));
        const script = `
            const {HyperionMaster} = await import(${JSON.stringify(new URL('../../build/indexer/modules/master.js', import.meta.url).href)});
            const {action} = await import(${JSON.stringify(new URL('../../build/indexer/definitions/index-templates.js', import.meta.url).href)});
            let request;
            const master = Object.assign(Object.create(HyperionMaster.prototype), {
                conf: {settings: {chain: ${JSON.stringify(chain)}, use_read_aliases: true}},
                esClient: {indices: {
                    putIndexTemplate: async value => {request = value; return {acknowledged: true};},
                    getIndexTemplate: async () => ({index_templates: [{name: request.name,
                        index_template: {index_patterns: request.index_patterns, template: request.template}}]}),
                    deleteTemplate: async () => ({acknowledged: true})
                }}
            });
            await master.updateIndexTemplates([{name: 'action', type: 'action'}], {action});
            if (!request) throw new Error('Production action template was not captured');
            console.log('ACTION_TEMPLATE=' + JSON.stringify(request));
        `;
        const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
            cwd: directory, env: {...process.env, CONFIG_JSON: join(directory, 'chain.json'), CHAIN_NAME: chain, TRACE_LOGS: 'false'},
            encoding: 'utf8', timeout: 15000, maxBuffer: 512 * 1024, windowsHide: true
        });
        const lines = stdout.split(/\r?\n/).filter(line => line.startsWith('ACTION_TEMPLATE='));
        assert.equal(lines.length, 1);
        return JSON.parse(lines[0].slice('ACTION_TEMPLATE='.length));
    } finally {
        const target = resolve(directory);
        assert.equal(dirname(target), parent); assert(basename(target).startsWith(prefix));
        rmSync(target, {recursive: true, force: true});
    }
}

async function emptyIndexCount(index) {
    await client.indices.refresh({index});
    const result = await client.count({index}); assert.equal(result._shards.failed, 0); return result.count;
}

// The pinned Undici connection retains its constructor header/body timeout.
// A longer per-request timeout cannot extend that pool limit. Keep every health
// request short while preserving Elasticsearch's normal delayed allocation.
async function waitForHealthyCopies(index, maximumWaitMs) {
    const started = performance.now(), deadline = started + maximumWaitMs;
    let polls = 0, expectedHealthTimeoutResponses = 0, maximumDelayedShards = 0, health;
    for (;;) {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) throw new Error(`Owned two-node cluster did not recover green within ${maximumWaitMs}ms: ${JSON.stringify(health)}`);
        const response = await client.cluster.health({...(index ? {index} : {}), wait_for_nodes: '2', wait_for_status: 'green',
            timeout: `${Math.min(1000, remaining)}ms`}, {requestTimeout: Math.min(5000, remaining), meta: true, ignore: [408]});
        health = response.body;
        assert.equal(health.cluster_name, clusterName); assert.equal(typeof health.timed_out, 'boolean');
        assert(['green', 'yellow', 'red'].includes(health.status));
        assert.equal(response.statusCode, health.timed_out ? 408 : 200);
        if (response.statusCode === 408) expectedHealthTimeoutResponses++;
        polls++; maximumDelayedShards = Math.max(maximumDelayedShards, health.delayed_unassigned_shards ?? 0);
        if (!health.timed_out && health.status === 'green' && health.number_of_nodes === 2) {
            return {health, polls, expectedHealthTimeoutResponses, elapsedMs: performance.now() - started, maximumDelayedShards,
                serverTimeoutPerPollMs: 1000, requestTimeoutPerPollMs: 5000, maximumWaitMs};
        }
        await sleep(Math.min(100, Math.max(0, deadline - performance.now())));
    }
}

try {
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    report.versions = {};
    for (const [packageName, expected] of [['@elastic/elasticsearch', '8.19.1'], ['@elastic/transport', '8.10.1']]) {
        const installed = installedVersion(packageName);
        assert.equal(installed, expected); assert.equal(lock.packages[`node_modules/${packageName}`].version, installed);
        report.versions[packageName] = installed;
    }
    report.source = {gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', timeout: 10000}).trim(),
        scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), modules: {}};
    const gitInputHash = relative => {
        const disk = readFileSync(join(root, relative));
        const committed = execFileSync('git', ['show', `${report.source.gitHead}:${relative}`],
            {cwd: root, timeout: 10000, maxBuffer: 8 * 1024 * 1024});
        assert.equal(disk.toString('utf8').replaceAll('\r\n', '\n'), committed.toString('utf8').replaceAll('\r\n', '\n'),
            `Qualification input differs from its reported Git commit: ${relative}`);
        return sha256(committed);
    };
    report.source.gitScriptSha256 = gitInputHash('scripts/qualification/check-action-source-journal.mjs');
    report.source.handoffCaseSha256 = gitInputHash('scripts/qualification/action-handoff-outcomes.mjs');
    report.source.gitLockfileSha256 = gitInputHash('package-lock.json');
    for (const [directory, name] of [['history', 'action-source-journal'], ['history', 'action-history-manifest'],
        ['history', 'action-source-admission'], ['history', 'action-source-inventory'], ['history', 'action-confirmed-publication'],
        ['history', 'action-producer-epoch'],
        ['workers', 'ds-pool'],
        ['protocol', 'selection'], ['protocol', 'contract-cache'], ['protocol', 'native-action-metadata'], ['protocol', 'source-bindings'],
        ['protocol', 'hex'], ['helpers', 'action-sequences'], ['helpers', 'uint64'], ['helpers', 'action-dedup'],
        ['history', 'action-sequence-storage'], ['protocol', 'immutable-bundle-store'], ['helpers', 'bounded-json'],
        ['definitions', 'index-templates'], ['modules', 'master']]) {
        report.source.modules[name] = {sourceSha256: sha256(readFileSync(new URL(`../../src/indexer/${directory}/${name}.ts`, import.meta.url))),
            gitSourceSha256: gitInputHash(`src/indexer/${directory}/${name}.ts`),
            emittedSha256: sha256(readFileSync(new URL(`../../build/indexer/${directory}/${name}.js`, import.meta.url)))};
    }
    report.source.trackedInputsMatchHead = true;
    const {ActionHistorySourceJournal} = await import('../../build/indexer/history/action-source-journal.js');
    const {validateActionHistoryBlockPlan, actionHistoryPlanId, fingerprintActionHistoryEffect, actionHistoryManifestBounds,
        actionHistoryManifestId} = await import('../../build/indexer/history/action-history-manifest.js');
    const {qualifyActionHandoffOutcomes} = await import('./action-handoff-outcomes.mjs');
    const engine = JSON.parse(docker(['version', '--format', '{{json .Server}}']));
    report.docker = Object.fromEntries(['Version', 'ApiVersion', 'GitCommit', 'Os', 'Arch'].map(key => [key, engine[key]]));
    networkId = docker(['network', 'create', '--driver', 'bridge', ...labels('network'), network]); assert.match(networkId, /^[a-f0-9]{64}$/);
    const net = JSON.parse(docker(['network', 'inspect', networkId]))[0]; owned(net, 'network');
    assert.equal(net.Id, networkId); assert.equal(net.Name, network); assert.equal(net.Driver, 'bridge'); assert.equal(net.Internal, false);
    const primary = launch('primary'), replica = launch('replica');
    client = await connect(primary); await connect(replica);
    assert.equal(primary.server.clusterUuid, replica.server.clusterUuid);
    const {health} = await waitForHealthyCopies(undefined, 30000);
    assert.equal(health.timed_out, false); assert.equal(health.number_of_nodes, 2); assert.equal(health.status, 'green');
    report.server = {primary: primary.server, replica: replica.server,
        topology: 'One master/data/ingest node and one data/ingest replica; no master failover qualification',
        limitsPerNode: {cpus: 2, memoryBytes: 2 * 1024 ** 3, dataTmpfsBytes: 256 * 1024 ** 2}};
    const chain = `hyp-journal-${run}`; fixtureChain = chain;
    const journal = new ActionHistorySourceJournal(client, chain, 1);
    const tracked = instrument(client, journal.index), observedJournal = new ActionHistorySourceJournal(tracked.client, chain, 1);
    const first = sourcePlan(100), firstId = actionHistoryPlanId(validateActionHistoryBlockPlan(first));
    const sequences = ['1', '9007199254740991', '9007199254740992', '9007199254740993',
        '9223372036854775807', '9223372036854775808', '18446744073709551615'];
    const actions = sequences.map(value => logical(first, first.transactions[0].transactionId, value));
    let sealed;

    const ordinaryIndex = `${chain}-action-v1-journal-isolation`, readAlias = `${chain}-action-read`, actionWildcard = `${chain}-action-*`;
    await check('the actual production action template, index sort and read alias are present before journal provisioning', async () => {
        const template = productionActionTemplate(chain);
        assert.deepEqual(template.index_patterns, [actionWildcard]);
        assert.deepEqual(template.template.aliases, {[readAlias]: {}});
        assert.equal(template.template.settings.index.sort.field, 'global_sequence');
        assert.equal((await client.indices.putIndexTemplate(template)).acknowledged, true);
        assert.equal((await client.indices.create({index: ordinaryIndex})).acknowledged, true);
        const write = await client.index({index: ordinaryIndex, id: 'ordinary-history-sentinel',
            document: {global_sequence: 1, block_num: 1}, wait_for_active_shards: 'all', refresh: true});
        assert.equal(write._shards.failed, 0); assert.equal(write._shards.successful, 2);
        assert.deepEqual(Object.keys(await client.indices.getAlias({name: readAlias})), [ordinaryIndex]);
        return {template: template.name, ordinaryIndex, wildcard: actionWildcard, readAlias,
            source: 'Actual emitted index-templates.action and HyperionMaster.updateIndexTemplates'};
    });

    await check('malformed plans, count/copy bounds and pre-cancellation fail before journal provisioning', async () => {
        const invalidChain = `${chain}-invalid`, invalid = new ActionHistorySourceJournal(client, invalidChain, 1);
        const bad = {...first, schemaVersion: 2};
        await assert.rejects(invalid.preparePlan(bad), /plan|schema|history/i);
        const huge = {...first, transactions: new Array(actionHistoryManifestBounds.maximumTransactions + 1).fill(first.transactions[0])};
        await assert.rejects(invalid.preparePlan(huge), /bounded|transaction|count|limit/i);
        let invoked = 0;
        const accessor = {...first, source: {...first.source}};
        Object.defineProperty(accessor.source, 'blockId', {enumerable: true, get() {invoked++; throw new Error('getter must not run');}});
        await assert.rejects(invalid.preparePlan(accessor), /accessor|descriptor|property|data|history/i); assert.equal(invoked, 0);
        const cancelled = new AbortController(); cancelled.abort();
        await assert.rejects(invalid.preparePlan(first, cancelled.signal), aborted);
        assert.equal(await client.indices.exists({index: invalid.index}), false);
        return {maximumTransactions: actionHistoryManifestBounds.maximumTransactions,
            perRecordMaximumBytes: actionHistoryManifestBounds.maximumBytes, provisioned: false, accessorsInvoked: invoked};
    });

    await check('real replicated plan prepare and validated realtime read are idempotent across adapters', async () => {
        const prepared = await observedJournal.preparePlan(first); assert.equal(prepared.id, firstId); assert.deepEqual(prepared.plan, first);
        assert.deepEqual(await journal.readPlan(firstId), prepared);
        const again = await new ActionHistorySourceJournal(tracked.client, chain, 1).preparePlan(first);
        assert.deepEqual(again, prepared); assert(tracked.state.writes.some(write => write.method === 'index'), 'Retry must obtain a fresh CAS receipt');
        assert(tracked.state.durableReceipts.length > 0);
        const settings = (await client.indices.getSettings({index: journal.index, flat_settings: true, include_defaults: true}))[journal.index];
        assert.equal(Number(settings.settings['index.number_of_replicas']), 1);
        assert.equal(settings.settings['index.translog.durability'], 'request');
        report.observations.journal = {index: journal.index, replicas: 1, translogDurability: 'request', planId: firstId};
        report.qualification.realTwoCopyWrites = true;
    });

    await check('missing fragments and unplanned or malformed transaction identities cannot seal membership', async () => {
        await assert.rejects(journal.readManifest(firstId), isReadFailure('missing'));
        await assert.rejects(journal.seal(firstId), /missing|incomplete|fragment|membership/i);
        await assert.rejects(journal.recordFragment(firstId, 'f'.repeat(64), []), /unplanned|transaction|fragment/i);
        await assert.rejects(journal.recordFragment(firstId, '01', []), /transaction|fragment|identity/i);
        await assert.rejects(journal.readPlan('h45actionplan1:' + '0'.repeat(64)), isReadFailure('missing'));
        await assert.rejects(journal.readPlan('malformed-plan'), /plan|identity|invalid/i);
        await assert.rejects(journal.readManifest(firstId), isReadFailure('missing'));
    });

    await check('complete source order includes process-empty, excluded and no-effect transaction fragments', async () => {
        for (const transaction of [...first.transactions].reverse().slice(0, 3)) {
            const prepared = await journal.recordFragment(firstId, transaction.transactionId, []);
            assert.deepEqual(prepared.fragment.effects, []);
            assert.deepEqual(await journal.recordFragment(firstId, transaction.transactionId, []), prepared);
        }
        await assert.rejects(journal.seal(firstId), /missing|incomplete|fragment|membership/i);
        const prepared = await journal.recordFragment(firstId, first.transactions[0].transactionId, actions);
        assert.deepEqual(prepared.fragment.effects, actions.map(fingerprintActionHistoryEffect));
        assert.deepEqual(prepared.fragment.effects.map(value => value.globalSequence), sequences);
        sealed = await journal.seal(firstId);
        assert.equal(sealed.id, actionHistoryManifestId(sealed.manifest, first));
        assert.deepEqual(sealed.manifest.fragments.map(value => value.transactionId), first.transactions.map(value => value.transactionId));
        assert.deepEqual(await journal.readManifest(firstId), sealed);
        assert.deepEqual(await journal.seal(firstId), sealed);
        return {transactions: 4, nonemptyTransactions: 1, explicitEmptyTransactions: 3, effects: sequences.length,
            sequences, finiteOpaqueDataFingerprinted: true, readinessAuthority: false};
    });

    await check('journal records stay outside ordinary action wildcards, read aliases, mappings and index sort', async () => {
        await client.indices.refresh({index: journal.index});
        assert((await client.count({index: journal.index})).count > 0);
        for (const target of [actionWildcard, readAlias]) {
            assert.deepEqual(Object.keys(await client.indices.get({index: target})), [ordinaryIndex]);
            const result = await client.search({index: target, query: {match_all: {}}, track_total_hits: true});
            assert.equal(result._shards.failed, 0); assert.equal(result.timed_out, false);
            assert.deepEqual(result.hits.total, {value: 1, relation: 'eq'});
            assert.deepEqual(result.hits.hits.map(hit => hit._id), ['ordinary-history-sentinel']);
        }
        assert.deepEqual((await client.indices.getAlias({index: journal.index}))[journal.index].aliases, {});
        const settings = (await client.indices.getSettings({index: journal.index, flat_settings: true}))[journal.index].settings;
        assert.equal(settings['index.sort.field'], undefined);
        const mappings = (await client.indices.getMapping({index: journal.index}))[journal.index].mappings;
        assert.equal(mappings._meta.hyperion_kind, 'action-source-journal'); assert.equal(mappings.dynamic, 'strict');
        assert.equal(mappings.properties.global_sequence, undefined); assert.equal(mappings.properties.payload.type, 'binary');
        report.observations.actionHistoryIsolation = {journalIndex: journal.index, ordinaryIndex, readAlias,
            wildcard: actionWildcard, ordinaryHits: 1, journalInActionAlias: false, inheritedActionSort: false};
        return report.observations.actionHistoryIsolation;
    });

    await check('complete exact metadata and opaque finite data are fingerprinted without source coercion', async () => {
        const baseline = actions.at(-1), pristine = structuredClone(baseline), effect = fingerprintActionHistoryEffect(baseline);
        assert.deepEqual(baseline, pristine); assert.equal(effect.globalSequence, '18446744073709551615');
        assert.notEqual(effect.documentSha256, fingerprintActionHistoryEffect({...baseline, act: {...baseline.act,
            data: {...baseline.act.data, fraction: 1.5}}}).documentSha256);
        assert.equal(effect.metadataSha256, fingerprintActionHistoryEffect({...baseline, act: {...baseline.act, data: 'opaque'}}).metadataSha256);
        const before = tracked.state.writes.length;
        for (const sequence of [Number.MAX_SAFE_INTEGER + 1, '18446744073709551616', '0001']) {
            await assert.rejects(observedJournal.recordFragment(firstId, first.transactions[0].transactionId,
                [{...baseline, global_sequence: sequence}]), /sequence|uint64|canonical|history|storage/i);
        }
        await assert.rejects(observedJournal.recordFragment(firstId, first.transactions[0].transactionId,
            [{...baseline, act: {...baseline.act, data: {bad: Infinity}}}]), /finite|number|history|JSON/i);
        const oversized = new Array(actionHistoryManifestBounds.maximumEffects + 1).fill(baseline);
        await assert.rejects(observedJournal.recordFragment(firstId, first.transactions[0].transactionId, oversized), /bounded|effect|count|limit/i);
        assert.equal(tracked.state.writes.length, before, 'Invalid complete fragments cannot write partial effects');
    });

    await check('cross-plan/source actions, excluded effects and changed stable links are refused', async () => {
        const second = sourcePlan(101), prepared = await journal.preparePlan(second), tx = second.transactions[0].transactionId;
        await assert.rejects(journal.recordFragment(prepared.id, first.transactions[0].transactionId, []), /unplanned|transaction/i);
        await assert.rejects(journal.recordFragment(prepared.id, tx, [actions[0]]), /source|block|transaction|binding/i);
        await assert.rejects(journal.recordFragment(prepared.id, second.transactions[2].transactionId,
            [logical(second, second.transactions[2].transactionId, '42')]), /excluded|effect|disposition/i);
        await assert.rejects(journal.recordFragment(firstId, first.transactions[0].transactionId, [...actions].reverse()), /conflict|immutable/i);
        await assert.rejects(journal.recordFragment(firstId, first.transactions[0].transactionId,
            actions.map((action, index) => index ? action : {...action, producer: 'changed'})), /conflict|immutable/i);
        assert.deepEqual(await journal.readManifest(firstId), sealed);
    });

    await check('duplicate effect roots within and across transactions never form a sealed manifest', async () => {
        const input = sourcePlan(102, 2), prepared = await journal.preparePlan(input);
        const left = logical(input, input.transactions[0].transactionId, '9007199254740993');
        await assert.rejects(journal.recordFragment(prepared.id, input.transactions[0].transactionId, [left, left]), /repeated|duplicate|effect|sequence/i);
        await journal.recordFragment(prepared.id, input.transactions[0].transactionId, [left]);
        await journal.recordFragment(prepared.id, input.transactions[1].transactionId,
            [logical(input, input.transactions[1].transactionId, left.global_sequence)]);
        await assert.rejects(journal.seal(prepared.id), /repeated|duplicate|effect|sequence/i);
        await assert.rejects(journal.readManifest(prepared.id), isReadFailure('missing'));
    });

    await check('an explicit zero-transaction source block seals only its declared empty membership', async () => {
        const input = sourcePlan(103, 0), prepared = await journal.preparePlan(input);
        const empty = await journal.seal(prepared.id); assert.deepEqual(empty.manifest.fragments, []);
        assert.deepEqual(await new ActionHistorySourceJournal(client, chain, 1).readManifest(prepared.id), empty);
        return {constructedEmptySourceRecord: true, actualCapturedEmptyBlock: false, sinkReadiness: false};
    });

    await check('secondary data-node restart recovers replicated journal bytes while the master stays alive', async () => {
        const before = await client.nodes.info();
        const oldNode = Object.entries(before.nodes).find(([, node]) => node.name === replica.name)?.[0]; assert(oldNode);
        assert(!before.nodes[oldNode].roles.includes('master'));
        const beforePlacement = await client.cat.shards({index: journal.index, format: 'json'});
        assert.equal(beforePlacement.length, 2); assert(beforePlacement.every(shard => shard.state === 'STARTED'));
        const restartedCopy = beforePlacement.find(shard => shard.node === replica.name); assert(restartedCopy);
        const ownedReplica = verifyContainer(replica); assert.equal(ownedReplica.State.Running, true);
        await replica.client.close(); clients.delete(replica.client);
        docker(['restart', replica.id]); await connect(replica);
        const recoveryWait = await waitForHealthyCopies(journal.index, 90000), recovered = recoveryWait.health;
        assert.equal(recovered.timed_out, false); assert.equal(recovered.status, 'green'); assert.equal(recovered.number_of_nodes, 2);
        const after = await client.nodes.info();
        const newNode = Object.entries(after.nodes).find(([, node]) => node.name === replica.name)?.[0]; assert(newNode); assert.notEqual(newNode, oldNode);
        const shards = await client.cat.shards({index: journal.index, format: 'json'});
        assert.equal(shards.length, 2); assert(shards.every(shard => shard.state === 'STARTED'));
        assert.deepEqual(new Set(shards.map(shard => shard.prirep)), new Set(['p', 'r']));
        assert.deepEqual(await new ActionHistorySourceJournal(client, chain, 1).readManifest(firstId), sealed);
        assert.deepEqual(await new ActionHistorySourceJournal(replica.client, chain, 1).readManifest(firstId), sealed);
        const fresh = await new ActionHistorySourceJournal(tracked.client, chain, 1).seal(firstId); assert.deepEqual(fresh, sealed);
        report.qualification.replicaPeerRecovery = true;
        return {oldDataNodeId: oldNode, recoveredDataNodeId: newNode, primaryAndReplicaStarted: true,
            restartedCopyWas: restartedCopy.prirep === 'p' ? 'primary' : 'replica', beforePlacement, afterPlacement: shards,
            recoveryWait, dataTmpfsRecreated: true, newJournalAdapters: true, masterFailoverQualified: false};
    });

    await check('interrupted multi-chunk plan preparation remains incomplete until identical repair', async () => {
        const input = sourcePlan(110, 6000), id = actionHistoryPlanId(validateActionHistoryBlockPlan(input));
        let injected = false;
        const fault = instrument(client, journal.index, {afterWrite(write, response) {
            if (!injected && write.request.document?.kind === 'chunk' && write.request.document.chunk_index === 1) {
                injected = true; throw new Error('simulated lost plan-chunk receipt after real replicated write');
            }
            return response;
        }});
        await assert.rejects(new ActionHistorySourceJournal(fault.client, chain, 1).preparePlan(input), /simulated lost plan-chunk receipt/);
        assert(injected); await assert.rejects(journal.readPlan(id), error => isReadFailure('missing')(error) || isReadFailure('incomplete')(error));
        const repair = instrument(client, journal.index), restarted = new ActionHistorySourceJournal(repair.client, chain, 1);
        assert.deepEqual(await restarted.preparePlan(input), {id, plan: validateActionHistoryBlockPlan(input)});
        assert(repair.state.writes.some(write => write.method === 'index'), 'Existing chunks require fresh complete-copy CAS receipts');
        return {transactions: input.transactions.length, injectedAfterRealTwoCopyWrite: true,
            freshCasRepairWrites: repair.state.writes.filter(write => write.method === 'index').length};
    });

    await check('simulated partial copy receipt is rejected despite real bytes and repaired with a fresh receipt', async () => {
        const input = sourcePlan(111), id = actionHistoryPlanId(validateActionHistoryBlockPlan(input)); let injected = false;
        const fault = instrument(client, journal.index, {afterWrite(write, response) {
            if (!injected && write.request.document?.kind === 'manifest') {
                injected = true; return {...response, _shards: {...response._shards, total: 2, successful: 1, failed: 1}};
            }
            return response;
        }});
        await assert.rejects(new ActionHistorySourceJournal(fault.client, chain, 1).preparePlan(input), /receipt|durab|cop/i); assert(injected);
        // A realtime read observes bytes. It does not provide a fresh all-copy write receipt.
        const observed = await journal.readPlan(id); assert.deepEqual(observed.plan, input);
        const repair = instrument(client, journal.index);
        const prepared = await new ActionHistorySourceJournal(repair.client, chain, 1).preparePlan(input);
        assert.deepEqual(prepared, observed); assert(repair.state.writes.some(write => write.method === 'index'));
        assert(repair.state.durableReceipts.every(receipt => receipt.successful === 2 && receipt.failed === 0));
        return {faultKind: 'Simulated returned shard receipt after actual successful two-copy write',
            getProvidesWriteReceipt: false, retryRequiresFreshWriteReceipt: true, actualReplicaLoss: false};
    });

    await check('unknown seal receipt cannot be repaired by GET alone; seal retries reassert complete copies', async () => {
        const input = sourcePlan(112, 0), prepared = await journal.preparePlan(input); let injected = false;
        const fault = instrument(client, journal.index, {afterWrite(write, response) {
            if (!injected && write.request.document?.kind === 'manifest' && write.request.document.bundle_id?.startsWith('h45actionseal1:')) {
                injected = true; throw new Error('simulated lost seal receipt after real replicated write');
            }
            return response;
        }});
        await assert.rejects(new ActionHistorySourceJournal(fault.client, chain, 1).seal(prepared.id), /simulated lost seal receipt/); assert(injected);
        const observer = instrument(client, journal.index);
        const seen = await new ActionHistorySourceJournal(observer.client, chain, 1, {readOnly: true}).readManifest(prepared.id);
        assert.deepEqual(seen.manifest.fragments, []); assert.equal(observer.state.writes.length, 0);
        const repair = instrument(client, journal.index);
        assert.deepEqual(await new ActionHistorySourceJournal(repair.client, chain, 1).seal(prepared.id), seen);
        assert(repair.state.writes.some(write => write.method === 'index' && write.request.document.bundle_id?.startsWith('h45actionseal1:')));
        return {validatedObservedMembershipReadable: true, observedReadGrantsSinkOrCopyAuthority: false, freshSealRepairRequired: true};
    });

    await check('cancellation after a real chunk write prevents later chunks and allows bounded restart repair', async () => {
        const input = sourcePlan(113, 6000), controller = new AbortController(); let injected = false;
        const fault = instrument(client, journal.index, {afterWrite(write, response) {
            if (!injected && write.request.document?.kind === 'chunk') {injected = true; controller.abort();}
            return response;
        }});
        await assert.rejects(new ActionHistorySourceJournal(fault.client, chain, 1).preparePlan(input, controller.signal), aborted);
        assert(injected); assert.equal(fault.state.writes.length, 1, 'No later write may follow observed cancellation');
        const repaired = await new ActionHistorySourceJournal(client, chain, 1).preparePlan(input);
        assert.deepEqual(await journal.readPlan(repaired.id), repaired);
        return {cancelledAfterRealChunkReceipt: true, retainedIncompleteWrites: 1, restarted: true};
    });

    await check('corrupt retained chunk bytes cannot be read or silently re-prepared', async () => {
        const input = sourcePlan(114), capture = instrument(client, journal.index);
        const prepared = await new ActionHistorySourceJournal(capture.client, chain, 1).preparePlan(input);
        const entry = capture.state.writes.find(write => write.request.document.kind === 'chunk'); assert(entry);
        const original = entry.request.document, corrupted = {...original, payload: Buffer.from('corrupt').toString('base64')};
        await client.index({index: journal.index, id: entry.request.id, document: corrupted, wait_for_active_shards: 'all', pipeline: '_none'});
        try {
            await assert.rejects(journal.readPlan(prepared.id), error => isReadFailure('invalid')(error) || isReadFailure('incomplete')(error));
            await assert.rejects(journal.preparePlan(input), /conflict|digest|invalid|integrity/i);
        } finally {
            // Restore only the exact owned fixture document; production repair is not inferred.
            await client.index({index: journal.index, id: entry.request.id, document: original, wait_for_active_shards: 'all', pipeline: '_none'});
        }
        assert.deepEqual(await journal.preparePlan(input), prepared);
    });

    await check('unsafe durability and replica settings are refused on the owned journal before writes', async () => {
        const changes = [['translog.durability', 'async', 'request'], ['auto_expand_replicas', '0-1', 'false'], ['number_of_replicas', 0, 1]];
        for (const [setting, value, restore] of changes) {
            await client.indices.putSettings({index: journal.index, settings: {[setting]: value}});
            const before = tracked.state.writes.length;
            try {await assert.rejects(observedJournal.preparePlan(sourcePlan(115)), /durability|retention|incompatible|replica/i);}
            finally {await client.indices.putSettings({index: journal.index, settings: {[setting]: restore}});}
            assert.equal(tracked.state.writes.length, before);
        }
        const restored = await client.cluster.health({index: journal.index, wait_for_status: 'green', timeout: '30s'}, {requestTimeout: 35000});
        assert.equal(restored.timed_out, false); assert.equal(restored.status, 'green');
    });

    await check('default and final ingest pipelines are rejected before owned journal mutation', async () => {
        const pipeline = `${chain}-remove-payload`;
        await client.ingest.putPipeline({id: pipeline, processors: [{remove: {field: 'payload', ignore_missing: true}}]});
        for (const setting of ['default_pipeline', 'final_pipeline']) {
            await client.indices.putSettings({index: journal.index, settings: {[setting]: pipeline}});
            const before = tracked.state.writes.length;
            try {await assert.rejects(observedJournal.preparePlan(sourcePlan(116)), /retention|incompatible|pipeline/i);}
            finally {await client.indices.putSettings({index: journal.index, settings: {[setting]: '_none'}});}
            assert.equal(tracked.state.writes.length, before);
        }
        await client.ingest.deletePipeline({id: pipeline});
    });

    await check('stored source pruning is rejected on an owned empty journal before record writes', async () => {
        const unsafe = new ActionHistorySourceJournal(client, `${chain}-pruned`, 1);
        const mapping = (await client.indices.getMapping({index: journal.index}))[journal.index].mappings;
        await client.indices.create({index: unsafe.index,
            settings: {number_of_shards: 1, number_of_replicas: 1, 'translog.durability': 'request',
                auto_expand_replicas: 'false', default_pipeline: '_none', final_pipeline: '_none'},
            mappings: {...mapping, _source: {excludes: ['payload']}}});
        await assert.rejects(unsafe.preparePlan(sourcePlan(117, 4, `${chain}-pruned`)), /source|incompatible|retention/i);
        assert.equal(await emptyIndexCount(unsafe.index), 0);
    });

    await check('read-only readers observe retained membership without provisioning or mutating storage', async () => {
        const absent = new ActionHistorySourceJournal(client, `${chain}-readonly-absent`, 1, {readOnly: true});
        await assert.rejects(absent.readPlan(firstId));
        await assert.rejects(absent.preparePlan(sourcePlan(118)), /read.only/i);
        assert.equal(await client.indices.exists({index: absent.index}), false);
        const observer = instrument(client, journal.index), readonly = new ActionHistorySourceJournal(observer.client, chain, 1, {readOnly: true});
        assert.deepEqual(await readonly.readPlan(firstId), {id: firstId, plan: validateActionHistoryBlockPlan(first)});
        assert.deepEqual(await readonly.readManifest(firstId), sealed);
        await assert.rejects(readonly.seal(firstId), /read.only/i);
        await assert.rejects(readonly.recordFragment(firstId, first.transactions[0].transactionId, actions), /read.only/i);
        assert.equal(observer.state.writes.length, 0);
        return {newIndexProvisioned: false, existingMembershipObserved: true, writes: 0};
    });

    await qualifyActionHandoffOutcomes({client, chain, targetIndex: ordinaryIndex, check, instrument, report});

    await check('journal and outcome components leave no native PIT or search context open', async () => {
        const stats = await client.nodes.stats({metric: ['indices'], index_metric: ['search']});
        assert.equal(stats._nodes.failed, 0);
        const counts = Object.fromEntries(Object.entries(stats.nodes).map(([id, node]) => [id, node.indices.search.open_contexts]));
        assert.equal(Object.keys(counts).length, 2); assert(Object.values(counts).every(value => value === 0));
        report.cleanup.openSearchContextsBeforeRemoval = counts;
        report.observations.realWriteReceipts = {count: tracked.state.durableReceipts.length,
            allConfiguredCopies: 2, everyObservedReceiptComplete: tracked.state.durableReceipts.every(value => value.successful === 2 && value.failed === 0)};
        return {perNodeOpenContexts: counts, runnerOpenedPits: 0};
    });
    report.qualification.sourceJournal = true;
    report.status = 'passed';
} catch (error) {
    report.status = 'failed'; report.error = String(error.stack ?? error);
} finally {
    if (report.status === 'failed') report.failureDiagnostics = [...containers.values()].map(captureFailureDiagnostics);
    // Even failed tests must check the owned server's remaining search contexts
    // when it is reachable; verified server removal also destroys its contexts.
    if (client && report.cleanup.openSearchContextsBeforeRemoval === null) {
        try {
            const stats = await client.nodes.stats({metric: ['indices'], index_metric: ['search']});
            assert.equal(stats._nodes.failed, 0);
            const contexts = Object.fromEntries(Object.entries(stats.nodes).map(([id, node]) => [id, node.indices.search.open_contexts]));
            assert(Object.values(contexts).every(value => value === 0)); report.cleanup.openSearchContextsBeforeRemoval = contexts;
        } catch (error) {report.cleanup.contextObservationError = String(error.stack ?? error);}
    }
    for (const connection of clients) {
        try {await connection.close();}
        catch (error) {report.status = 'failed'; (report.cleanup.clientErrors ??= []).push(String(error.stack ?? error));}
    }
    for (const state of containers.values()) {
        const receipt = {name: state.name, id: state.id ?? null, removed: false, verified: false};
        try {
            const inventory = docker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${state.name}$`]).split('\n').filter(Boolean);
            assert(inventory.length <= 1);
            if (inventory.length) {
                const value = inspect(inventory[0]); owned(value, state.role);
                assert.equal(value.Name, '/' + state.name); assert.equal(value.Id, inventory[0]);
                if (state.id) assert.equal(value.Id, state.id); assert.equal(value.Config.Image, image);
                docker(['rm', '-f', '-v', value.Id]); receipt.removed = true;
            }
            assert.equal(docker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${state.name}$`]), '');
            if (state.id) assert.equal(docker(['ps', '-aq', '--no-trunc', '--filter', `id=${state.id}`]), '');
            receipt.verified = true;
        } catch (error) {report.status = 'failed'; receipt.error = String(error.stack ?? error);}
        report.cleanup.containers.push(receipt);
    }
    try {
        const inventory = docker(['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
        assert(inventory.length <= 1);
        if (inventory.length) {
            const value = JSON.parse(docker(['network', 'inspect', network]))[0]; owned(value, 'network');
            assert.equal(value.Name, network); if (networkId) assert.equal(value.Id, networkId);
            assert.equal(Object.keys(value.Containers ?? {}).length, 0); docker(['network', 'rm', value.Id]);
        }
        assert.equal(docker(['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.ID}}']), '');
        report.cleanup.network = true;
    } catch (error) {report.status = 'failed'; report.cleanup.networkError = String(error.stack ?? error);}
    report.cleanup.verified = report.cleanup.network && report.cleanup.containers.every(value => value.verified)
        && !report.cleanup.clientErrors;
    report.cleanup.allOwnedSearchContextsDestroyed = report.cleanup.verified;
    if (!report.cleanup.verified) report.status = 'failed';
    report.completedAt = new Date().toISOString();
    try {
        const json = JSON.stringify(report, null, 2) + '\n'; if (output) writeFileSync(output, json); process.stdout.write(json);
        if (report.status !== 'passed') process.exitCode = 1;
    } finally {clearInterval(keepAlive);}
}
