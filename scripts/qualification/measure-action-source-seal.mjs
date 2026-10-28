/** #371 component measurement: synthetic Antelope inputs, existing controlled ES transport.
 * Imports normal build output; wrappers observe original methods without replacing their behavior.
 * No Wire capture, broker, HTTP socket, Elasticsearch engine, or release qualification.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';

const reference = '032813e243d4451dbac0fcb15a73296f21e47054';
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const {values} = parseArgs({options: {'module-root': {type: 'string', default: ownRoot},
    'expected-source': {type: 'string', default: reference},
    output: {type: 'string'}, sizes: {type: 'string', default: '1,4,8,16,32'}}});
assert.ok(values.output, '--output is required');
const frozen = values['expected-source'];
assert.match(frozen, /^[0-9a-f]{40}$/, '--expected-source must be an exact immutable Git commit');
const root = resolve(values['module-root']), output = resolve(values.output);
const sizes = values.sizes.split(',').map(Number);
assert.ok(sizes.length > 0 && sizes.length <= 8 && sizes.every(n => Number.isSafeInteger(n) && n >= 1 && n <= 64),
    'Use 1..8 component sizes, each 1..64 transactions');
const git = (...args) => execFileSync('git', ['-C', root, ...args]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = character => character.repeat(64);
assert.equal(git('rev-parse', 'HEAD').toString().trim(), frozen, 'Module root must be the exact frozen source');
const evidence = [], visited = new Set();
function bindTracked(path) {
    const raw = readFileSync(resolve(root, path)), original = git('show', `${frozen}:${path}`);
    assert.deepEqual(raw, original, `Changed frozen input: ${path}`);
    return {path, bytes: raw.length, sha256: sha(raw), gitBlob: git('rev-parse', `${frozen}:${path}`).toString().trim()};
}
// Bind every reachable local emitted import and its source-map source to the frozen Git tree.
// Normal build provenance is recorded by the caller; this does not substitute a hand-transpiler.
function bindEmission(path) {
    path = resolve(path); if (visited.has(path)) return; visited.add(path);
    assert.ok(path.startsWith(root + '/') || path.startsWith(root + '\\'));
    const raw = readFileSync(path), mapPath = path + '.map', mapRaw = readFileSync(mapPath);
    const map = JSON.parse(mapRaw);
    assert.equal(map.sources.length, 1);
    const sourcePath = relative(root, resolve(dirname(mapPath), map.sourceRoot ?? '', map.sources[0])).replaceAll('\\', '/');
    evidence.push({emitted: {path: relative(root, path).replaceAll('\\', '/'), bytes: raw.length, sha256: sha(raw)},
        sourceMap: {bytes: mapRaw.length, sha256: sha(mapRaw)}, source: bindTracked(sourcePath)});
    for (const match of raw.toString().matchAll(/\b(?:from|import)\s*['"](\.[^'"]+\.js)['"]/g)) {
        bindEmission(resolve(dirname(path), match[1]));
    }
}
const entry = resolve(root, 'build/indexer/history/action-source-admission.js');
bindEmission(entry);
const seam = bindTracked('tests/unit/protocol-frontier-memory.mjs');
const packageInputs = ['package.json', 'package-lock.json', 'tsconfig.json'].map(bindTracked);
const [{ActionSourceAdmissionStore}, {frontierMemoryClient}] = await Promise.all([
    import(pathToFileURL(entry).href), import(pathToFileURL(resolve(root, seam.path)).href)]);

function sourceInput(count) {
    return {profileId: 'antelope-default-v1',
        source: {chainId: hex('1'), blockNum: 12, blockId: hex('2'), producer: 'producer', timestamp: '2026-10-20T00:00:00.000'},
        policy: {schemaVersion: 1, parserVersion: '3.2', actionBlacklist: [], actionWhitelist: [],
            rootOnly: false, maxDepth: 0, maxInline: 0, eosioAlias: 'eosio'},
        traces: Array.from({length: count}, (_, ordinal) => {
            const id = sha(`synthetic-transaction-${ordinal}`), sequence = String(100 + ordinal);
            return ['transaction_trace_v0', {id, status: 0, scheduled: false, failed_dtrx_trace: null,
                except: null, error_code: null, cpu_usage_us: 15, net_usage_words: 2, partial: null,
                action_traces: [['action_trace_v0', {action_ordinal: 1, creator_action_ordinal: 0, receiver: 'token',
                    receipt: ['action_receipt_v0', {receiver: 'token', act_digest: hex('e'), global_sequence: sequence,
                        recv_sequence: sequence, auth_sequence: [{account: 'alice', sequence}], code_sequence: 1, abi_sequence: 21}],
                    act: {account: 'token', name: 'transfer', authorization: [{actor: 'alice', permission: 'active'}], data: '0102'},
                    context_free: false, except: null, error_code: null, elapsed: '0', console: ''}]]}];
        })};
}
function finalAction(ordinal) {
    const sequence = String(100 + ordinal);
    return {'@timestamp': '2026-10-20T00:00:00.000', block_num: 12, block_id: hex('2'), producer: 'producer',
        trx_id: sha(`synthetic-transaction-${ordinal}`), action_ordinal: 1, creator_action_ordinal: 0,
        global_sequence: sequence, act_digest: hex('e'), code_sequence: 1, abi_sequence: 21, cpu_usage_us: 15, net_usage_words: 2,
        act: {account: 'token', name: 'transfer', authorization: [{actor: 'alice', permission: 'active'}], data: {amount: ordinal + 0.25}},
        receipts: [{receiver: 'token', global_sequence: sequence, recv_sequence: sequence, auth_sequence: [{account: 'alice', sequence}]}]};
}
const increment = (object, name, amount = 1) => {object[name] = (object[name] ?? 0) + amount;};
const kind = id => String(id).split(':')[0];

function instrument(memory, store) {
    let active, phase = 'outside', restores = [];
    const wrap = (owner, name, observer) => {
        const original = owner[name]; assert.equal(typeof original, 'function', `Original ${name} is required`);
        owner[name] = async function (...args) {return observer.call(this, original, args);};
        restores.push(() => {owner[name] = original;});
    };
    for (const [owner, method, stage] of [[store, 'resolve', 'resolve'], [store.journal, 'seal', 'seal'],
        [store.journal, 'sealPlan', 'sealPlan']]) wrap(owner, method, async function (original, args) {
        if (!active) return Reflect.apply(original, this, args);
        const previous = phase, record = active, start = performance.now(); phase = stage;
        increment(record.methodCalls, stage);
        try {return await Reflect.apply(original, this, args);} finally {
            increment(record.wallMs, stage, performance.now() - start); phase = previous;
        }
    });
    // compile is synchronous: retain its return type and exact exception behavior.
    const compile = store.compile;
    store.compile = function (...args) {
        const result = Reflect.apply(compile, this, args);
        if (active) {increment(active.methodCalls, 'compile'); increment(active.methodCalls, 'compiledTransactions', result.plan.transactions.length);}
        return result;
    };
    restores.push(() => {store.compile = compile;});
    wrap(store.journal, 'readFragment', async function (original, args) {
        const record = active;
        const visit = record ? {transactionId: args[1], outcome: 'pending'} : undefined;
        if (visit) record.fragmentVisits.push(visit);
        try {const value = await Reflect.apply(original, this, args); if (visit) visit.outcome = 'read'; return value;}
        catch (error) {if (visit) visit.outcome = error.code ?? error.name; throw error;}
    });
    wrap(store.journal.bundles, 'prepare', async function (original, args) {
        if (active) {increment(active.prepares, kind(args[0])); increment(active.preparesByPhase[phase] ??= {}, kind(args[0]));}
        return Reflect.apply(original, this, args);
    });
    for (const [owner, method, label] of [[memory.client.indices, 'get', 'getIndex'], [memory.client.indices, 'create', 'createIndex'],
        [memory.client, 'get', 'get'], [memory.client, 'create', 'create'], [memory.client, 'index', 'index']]) {
        wrap(owner, method, async function (original, args) {
            if (active) {increment(active.transport, label); increment(active.transportByPhase[phase] ??= {}, label);}
            return Reflect.apply(original, this, args);
        });
    }
    return {
        async measure(prefix, work) {
            assert.equal(active, undefined);
            const record = {prefix, methodCalls: {}, wallMs: {}, fragmentVisits: [], prepares: {}, preparesByPhase: {}, transport: {}, transportByPhase: {}};
            active = record; phase = 'trySeal'; const start = performance.now(), logStart = memory.calls.length;
            try {record.result = await work(); return record;} finally {
                record.wallMs.trySeal = performance.now() - start; active = undefined; phase = 'outside';
                const logged = {};
                for (const call of memory.calls.slice(logStart)) increment(logged, call.method);
                assert.deepEqual(record.transport, logged, 'Wrapper counts must match the unchanged transport seam log');
                record.transportVerifiedFromExistingSeamLog = true;
            }
        },
        restore() {for (const restore of restores.reverse()) restore();}
    };
}
async function run(count, schedule) {
    const memory = frontierMemoryClient(1), store = new ActionSourceAdmissionStore(memory.client, 'fixture', 1);
    const frameHex = '010203', schemaJson = '{}', captureSha256 = sha(Buffer.from(frameHex, 'hex'));
    const ingressId = await store.retainIngress({schemaVersion: 1, chainId: hex('1'), protocolId: 'antelope', profileId: 'antelope-default-v1',
        readerSessionId: 'synthetic-component-371', components: [], frameHex, schemaJson, captureSha256});
    const sourceId = await store.retainSource({schemaVersion: 2, frameHex, schemaJson, captureSha256, ingressId, previousBlockId: hex('3'),
        producer: {protocolId: 'antelope', profileId: 'antelope-default-v1', codeRevision: 'f'.repeat(40), configurationSha256: hex('4'), pluginsSha256: hex('5')},
        executableSha256: hex('6'), inventoryInput: sourceInput(count)});
    const admission = await store.admit(sourceId, {name: 'fixture-action-v1-000001', uuid: 'controlled-target-uuid'});
    assert.equal(admission.incomplete, null); assert.equal(admission.inventory.transactions.length, count);
    const metrics = instrument(memory, store), attempts = [], preparations = [];
    try {
        if (schedule === 'incremental') attempts.push(await metrics.measure(0, () => store.trySeal(admission)));
        for (let ordinal = 0; ordinal < count; ordinal++) {
            const dispatch = admission.inventory.transactions[ordinal].dispatch;
            assert.ok(dispatch, 'Every synthetic transaction must require processing');
            const before = memory.calls.length, start = performance.now();
            await store.prepareTransaction(admission, ordinal, Buffer.from(dispatch.canonicalJson), [finalAction(ordinal)]);
            preparations.push({ordinal, wallMs: performance.now() - start, transportCalls: memory.calls.length - before});
            if (schedule === 'incremental') attempts.push(await metrics.measure(ordinal + 1, () => store.trySeal(admission)));
        }
        if (schedule === 'final-only') attempts.push(await metrics.measure(count, () => store.trySeal(admission)));
        assert.deepEqual(attempts.map(value => value.result), attempts.map(value => value.prefix === count));
        const manifest = await store.journal.readManifest(admission.planId);
        assert.equal(manifest.manifest.fragments.length, count);
        assert.deepEqual(manifest.manifest.fragments.map(value => value.effects.length), Array(count).fill(1));
        const actual = {read: 0, missing: 0};
        const totals = {methodCalls: {}, prepares: {}, transport: {}, wallMs: {}};
        for (const attempt of attempts) {
            for (const visit of attempt.fragmentVisits) increment(actual, visit.outcome);
            for (const key of Object.keys(totals)) for (const [name, value] of Object.entries(attempt[key])) increment(totals[key], name, value);
        }
        return {transactions: count, schedule, sourceId, planId: admission.planId, attempts, preparations,
            successfulFragmentVisits: actual.read, missingFragmentVisits: actual.missing, totals,
            verifiedManifest: {id: manifest.id, fragments: count, effects: count}};
    } finally {metrics.restore();}
}
const started = performance.now(), cases = [];
for (const size of sizes) cases.push(await run(size, 'incremental'));
cases.push(await run(Math.max(...sizes), 'final-only'));
const result = {schemaVersion: 1, issue: 371, classification: 'synthetic-component-measurement-controlled-transport',
    referenceHead: reference, frozenHead: frozen, frozenTree: git('rev-parse', `${frozen}^{tree}`).toString().trim(),
    runtime: {execPath: process.execPath, sha256: sha(readFileSync(process.execPath)), version: process.version, platform: process.platform, arch: process.arch},
    command: [process.execPath, ...process.argv.slice(1)], moduleRoot: root,
    normalEmissionSources: evidence, controlledTransport: seam, packageInputs,
    harness: {path: fileURLToPath(import.meta.url), sha256: sha(readFileSync(fileURLToPath(import.meta.url)))},
    elapsedMs: performance.now() - started, cases,
    limits: ['Synthetic Antelope parser-boundary inputs, not captured Wire data or ABI decoding.',
        'The existing in-memory transport simulates ES/CAS/all-copy receipts; no ES engine, broker or native storage.',
        'Transparent counting wrappers add overhead. Elapsed wall time is descriptive, nested, and not CPU or original replay latency.',
        'Record-preparation work occurs outside trySeal measurement. Owner/canonical/publication grants and full-worker progress are not established.',
        'No production source, freshness/digest/durability guards, flags, budgets or defaults are changed.']};
mkdirSync(dirname(output), {recursive: true}); writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({output, sha256: sha(readFileSync(output)), elapsedMs: result.elapsedMs,
    cases: cases.map(value => ({transactions: value.transactions, schedule: value.schedule, attempts: value.attempts.length,
        successfulFragmentVisits: value.successfulFragmentVisits, missingFragmentVisits: value.missingFragmentVisits,
        prepares: value.totals.prepares, transport: value.totals.transport}))}));
