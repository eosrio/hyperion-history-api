import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {monitor, verifyReadTrace} from './trace.mjs';

export const PLAN = Object.freeze({schemaVersion: 1, scope: 'synthetic-native-complete-kind',
    sdk: '7412889a14c84342551fd864ea3ebfcf28849385', driver: '7.2.0', mongodb: '8.0.34',
    profile: 'stateful-owner-v2-7412889-18d235e-complete-kind-engineering',
    budgets: {readAttempts: 12, responseRecords: 8, responseBytes: 65536},
    operationMS: 5000, transactionMS: 15000,
    required: ['source-admission', 'replica-primary', 'empty-owned-database', 'true-exhaustion', 'shared-totals',
        'same-snapshot-metadata', 'adaptive-retry-positive-control', 'bounded-find-failure', 'bounded-getMore-failure',
        'callback-retry-accounting', 'foreign-token-client-session', 'cancel-late-result', 'gap-takeover-fork', 'lifecycle-cleanup'],
    acceptance: {physicalMongoDB: 'pending-until-run', managedAPI: 'pending', publicHTTP: 'pending', atomicParity: 'pending'}});
const hash = value => createHash('sha256').update(value).digest('hex');
const hex = n => n.toString(16).padStart(64, '0');
const plain = value => JSON.parse(JSON.stringify(value));
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const failure = error => ({name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null});
export function argumentsFor(argv, environment) {
    if (argv.length === 0 || argv.length === 1 && argv[0] === '--validate-plan') return null;
    assert.equal(argv.length, 6, 'Use --run --allow-failpoints --database NAME --output NEW_DIRECTORY');
    assert.equal(argv[0], '--run'); assert.equal(argv[1], '--allow-failpoints');
    assert.equal(argv[2], '--database'); assert.match(argv[3], /^h45_kind_[a-f0-9]{12}$/);
    assert.equal(argv[4], '--output'); assert.ok(argv[5].length > 0);
    const uri = environment.HYPERION_COMPLETE_KIND_MONGO_URI, parsed = new URL(uri);
    assert.equal(parsed.protocol, 'mongodb:'); assert.equal(parsed.hostname, '127.0.0.1');
    assert.equal(parsed.username + parsed.password + parsed.hash, '');
    assert.ok(parsed.pathname === '' || parsed.pathname === '/');
    const port = Number(parsed.port); assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 27017);
    assert.deepEqual([...parsed.searchParams.keys()].sort(), ['directConnection', 'replicaSet']);
    assert.equal(parsed.searchParams.get('directConnection'), 'true');
    const replicaSet = parsed.searchParams.get('replicaSet');
    assert.match(replicaSet, /^(?:h45_[a-z0-9_]{1,40}|h45rs_[a-f0-9]{32})$/);
    const member = replicaSet.startsWith('h45rs_') ? 'hyp-projection-' + replicaSet.slice(6) + '-replica:27017' : '127.0.0.1:' + port;
    return {uri, database: argv[3], output: resolve(argv[5]), member, replicaSet};
}

function definition(sdk, database) {
    return {family: sdk.STATEFUL_FAMILY, interfaceVersion: 1, id: 'complete-kind-native-qualification',
        binding: {chainId: hex(10), backendId: database, generation: database, mappingRevision: hash(JSON.stringify(PLAN)),
            hookArtifact: hash(readFileSync(fileURLToPath(import.meta.url))), hookRevision: hex(13), codecRevision: hex(14), normalizerRevision: hex(15)},
        selectors: [{id: 'synthetic', kind: 'action', contract: 'fixture', name: 'change', abiDeployment: 'synthetic-no-chain-authority', abiSha256: hex(16)}],
        records: [{kind: 'asset', integers: [{path: ['id'], type: 'uint64', vector: false}]},
            {kind: 'collection', integers: []}, {kind: 'empty', integers: []}]};
}
function limits() {
    return {value: {depth: 16, nodes: 256, fields: 32, arrayElements: 32, stringBytes: 1024, recordBytes: 4096, integerFields: 4, pathSegments: 8},
        envelope: {depth: 32, nodes: 8192, fields: 64, arrayElements: 128, stringBytes: 65536, recordBytes: 262144, integerFields: 4, pathSegments: 8},
        selectors: 1, recordKinds: 3, inputOccurrences: 0, inputBytes: 0, keyBytes: 128, readKeys: 8, readAttempts: 32,
        mutations: 16, candidateBytes: 262144, responseRecords: 8, responseBytes: 262144};
}
class Custody {
    constructor(directory) {this.directory = directory; this.entries = new Map();}
    async load(declaration, source) {return this.entries.get(declaration + source) ?? null;}
    async retain(candidate) {
        const key = candidate.declarationDigest + candidate.source.digest, before = this.entries.get(key);
        if (before) {assert.equal(before.digest, candidate.digest); return;}
        json(join(this.directory, 'candidate-' + candidate.digest + '.json'), candidate); this.entries.set(key, plain(candidate));
    }
}

export async function run(options) {
    // Source admission precedes creating any MongoClient or issuing native commands.
    const {admitNativeApiSourceOptions} = await import('../../../tests/unit/stateful-engineering-source-admission.mjs');
    const admitted = admitNativeApiSourceOptions({engineeringSourceProfile: PLAN.profile});
    const [{MongoClient}, logical, sdk, native, ownerNative, internal, managed] = await Promise.all([
        import('mongodb'), import('@eosrio/hyperion-sdk/projection-stateful'), import('@eosrio/hyperion-sdk/projection-stateful-owner-v2'),
        import('@eosrio/hyperion-backend-mongodb/stateful-owner-complete-kind-v1'),
        import('@eosrio/hyperion-backend-mongodb/stateful-owner-v2'),
        import('../../../packages/backend-mongodb/dist/stateful-owner-v2-internal.js'),
        import('../../../build/indexer/connections/stateful-complete-kind-client.js')]);
    assert.equal(JSON.parse(readFileSync(new URL('../../../node_modules/mongodb/package.json', import.meta.url))).version, PLAN.driver);
    assert.ok(!existsSync(options.output), 'Evidence directory must be new'); mkdirSync(options.output, {recursive: true});
    const trace = [], cases = [], sessions = [], closes = [], ownedMarker = randomBytes(24).toString('hex');
    let phase = {name: 'preflight'}, gate, afterData, owned = false, bounded, stopMonitor, failpointGranted = false;
    const admin = new MongoClient(options.uri, {retryReads: false, retryWrites: false, maxAdaptiveRetries: 0,
        maxPoolSize: 2, minPoolSize: 0, serverSelectionTimeoutMS: PLAN.operationMS, connectTimeoutMS: PLAN.operationMS});
    const boundedName = options.database + '_bounded', retryName = options.database + '_retry';
    const pool = new managed.StatefulCompleteKindMongoClient(() => ({uri: options.uri,
        options: {monitorCommands: true, appName: boundedName}}), (uri, config) => {
        const client = new MongoClient(uri, config), start = client.startSession.bind(client), db = client.db.bind(client), close = client.close.bind(client);
        client.startSession = config => {
            const session = start(config), end = session.endSession.bind(session), item = {ended: false}; sessions.push(item);
            session.endSession = async (...args) => {try {return await end(...args);} finally {item.ended = session.hasEnded;}};
            return session;
        };
        // Fault-injection gate only. All replies/errors and all command events come from the actual pinned driver/server.
        client.db = (...args) => {
            const selected = db(...args), command = selected.command.bind(selected);
            return new Proxy(selected, {get(target, name) {
                if (name === 'command') return async (input, config) => {
                    if (input.comment?.hyperion === 'stateful-complete-kind-v1') {
                        const before = gate; if (before) await before(input);
                        const reply = await command(input, config); if (afterData) await afterData(input, reply); return reply;
                    }
                    return command(input, config);
                };
                const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
            }});
        };
        client.close = async (...args) => {try {return await close(...args);} finally {closes.push('bounded');}};
        stopMonitor = monitor(client, options.database, 'bounded', () => phase, trace); return client;
    });
    const retry = new MongoClient(options.uri, {retryReads: true, retryWrites: true, maxAdaptiveRetries: 2, appName: retryName,
        monitorCommands: true, maxPoolSize: 1, minPoolSize: 0, serverSelectionTimeoutMS: PLAN.operationMS});
    const stopRetry = monitor(retry, options.database, 'retry-positive-control', () => phase, trace);
    let reportError;
    const report = {schemaVersion: 1, plan: PLAN, source: admitted, database: options.database,
        runtime: {node: process.version, executable: process.execPath, executableSha256: hash(readFileSync(process.execPath))},
        sourceAuthority: 'Synthetic native fixture only; no Antelope source, managed API, public HTTP or Atomic parity grant', cases,
        metrics: {responseBytes: 'Successful canonical SDK envelopes and composed JSON result, counted by the SDK',
            replyBsonBytes: 'Driver-monitor reply BSON estimates including authority/lifecycle replies; not wire compression or buffers',
            dataAttempts: 'Actual projection find/getMore commands; authority metadata and resource lifecycle are recorded separately'}};
    const caseRun = async (name, work) => {
        phase = {name}; const start = trace.length;
        try {const result = await work(); cases.push({name, status: 'pass', ...result, trace: [start, trace.length]});}
        catch (error) {cases.push({name, status: 'failed', error: failure(error), trace: [start, trace.length]}); throw error;}
        finally {gate = undefined; afterData = undefined;}
    };
    const failpoint = async (appName, command, code, labels) => admin.db('admin').command({configureFailPoint: 'failCommand',
        mode: {times: 1}, data: {failCommands: [command], appName, errorCode: code, errorLabels: labels}});
    const arm = (command, code, labels) => {gate = async input => {if (input[command] === undefined) return;
        gate = undefined; await failpoint(boundedName, command, code, labels);};};
    try {
        await admin.connect();
        const hello = await admin.db('admin').command({hello: 1}), build = await admin.db('admin').command({buildInfo: 1});
        assert.equal(hello.isWritablePrimary, true); assert.equal(hello.setName, options.replicaSet);
        assert.equal(hello.me, options.member); assert.deepEqual(hello.hosts, [options.member]); assert.equal(build.version, PLAN.mongodb);
        report.server = {version: build.version, replicaSet: hello.setName, member: hello.me};
        const baseline = await admin.db('admin').command({getParameter: 1, 'failpoint.failCommand': 1});
        assert.equal(baseline['failpoint.failCommand'].mode, 0, 'Refuse an already armed shared failpoint'); failpointGranted = true;
        assert.deepEqual(await admin.db(options.database).listCollections().toArray(), [], 'Refuse a nonempty database');
        await admin.db(options.database).collection('_qualification_owner').insertOne({_id: ownedMarker, scope: PLAN.scope}, {writeConcern: {w: 'majority', j: true}});
        owned = true; bounded = await pool.get(PLAN.operationMS); assert.equal(await pool.get(PLAN.operationMS), bounded);
        assert.equal(closes.length, 0);
        const projection = await logical.captureStatefulDeclaration(definition(logical, options.database), limits());
        const draft = await sdk.captureStatefulOwnerDeclarationV2(projection, 2);
        const config = {client: bounded, databaseName: options.database, backendId: options.database, collectionPrefix: 'bounded', declaration: draft,
            receiptRetention: 4, rollbackRetentionBlocks: 4, rollbackRetentionBytes: 4194304, rollbackMaxBlockBytes: 1048576,
            operationTimeoutMS: PLAN.operationMS, transactionTimeoutMS: PLAN.transactionMS};
        const adapter = await native.createMongoDbStatefulCompleteKindAdapterV1(config, PLAN.budgets);
        const declaration = await sdk.negotiateStatefulOwnerV2(projection, {family: sdk.STATEFUL_OWNER_FAMILY_V2, interfaceVersion: 2,
            sourceInputVersions: [2], supported: sdk.STATEFUL_OWNER_HOST_CAPABILITIES_V2, limits: projection.limits}, adapter.capabilities);
        const capability = totals => ({family: sdk.STATEFUL_COMPLETE_KIND_FAMILY_V1, interfaceVersion: 1, limits: totals});
        let identity = {id: 'synthetic-native-owner', generation: 'one'}, lease;
        const custody = new Custody(options.output), noCancel = () => {};
        lease = await adapter.acquireOwner({expected: null, nextOwner: identity}, noCancel);
        const sourceFor = target => ({previous: target.target.previous.checkpoint, block: {...target.target.block, timeMs: '1001'}, inputs: []});
        const raw = async (number, id = number) => {
            const previous = (await adapter.recovery()).view;
            return sdk.captureStatefulRawTargetV2(declaration, {schemaVersion: 2, chainId: projection.definition.binding.chainId,
                declarationDigest: declaration.digest, owner: identity, previous,
                block: {blockNum: number, blockId: hex(id), previousBlockId: previous.checkpoint.blockId},
                rawSource: {commitId: 'synthetic:' + hex(id), selectionId: 'synthetic-selection:' + hex(id), observationId: 'synthetic-observation:' + hex(id), observationDigest: hex(id + 100)}});
        };
        const apply = async (target, hook) => {
            const before = phase; phase = {name: before.name + '-projection-write'};
            try {
                await adapter.admitRaw(lease, target);
                await sdk.executeStatefulOwnerBlockV2(declaration, adapter, lease, target.digest, sourceFor(target), custody, hook, noCancel);
                const candidate = [...custody.entries.values()].find(candidate => candidate.source.source.block.blockId === target.target.block.blockId);
                assert.ok(candidate);
                await adapter.retireRaw(lease, target.digest, candidate.source.digest, candidate.digest); return candidate;
            } finally {phase = before;}
        };
        const begin = async (totals = PLAN.budgets) => {
            const current = await adapter.recovery(), expected = current.view; phase = {...phase, expected, owner: identity, ownerClaim: current.owner.claimDigest};
            return {expected, totals, read: await adapter.completedRead(identity, expected, noCancel)};
        };
        const direct = async (kind, totals = PLAN.budgets, key) => {
            const state = await begin(totals);
            try {return await (key === undefined ? adapter.readCompletedKind(state.read, state.expected, kind, totals)
                : adapter.readCompletedKey(state.read, state.expected, {kind, key}, totals));}
            finally {adapter.closeRead(state.read);}
        };
        const compose = async (callback, totals = PLAN.budgets, guard = noCancel) => {
            const current = await adapter.recovery(), expected = current.view; phase = {...phase, expected, owner: identity, ownerClaim: current.owner.claimDigest};
            const selected = sdk.negotiateStatefulCompleteKindV1(declaration, totals, capability(PLAN.budgets), adapter.completeKindCapabilities);
            return sdk.composeStatefulOwnerCompleteKindReadV1(selected, adapter, identity, expected, callback, guard);
        };
        await caseRun('empty-exhaustion-zero-row-budget', async () => {
            const result = await direct('empty', {...PLAN.budgets, responseRecords: 0}); assert.deepEqual(plain(result.rows), []);
            return verifyReadTrace(trace, phase.name, {attempts: result.attempts, maximum: 1, success: true});
        });
        const first = await raw(1);
        await apply(first, async port => {for (const key of ['z', 'a', 'b']) port.put('collection', key, {name: key,
            created: key === 'z' ? '18446744073709551615' : '9007199254740993'}); port.put('asset', 'other', {id: '1'});});
        await caseRun('all-fields-membership-genuine-exhaustion', async () => {
            const result = await direct('collection');
            assert.deepEqual(plain(result.rows).sort((a, b) => a.key < b.key ? -1 : 1), ['a', 'b', 'z'].map(key => ({key,
                value: {name: key, created: key === 'z' ? '18446744073709551615' : '9007199254740993'}})));
            return {...verifyReadTrace(trace, phase.name, {attempts: result.attempts, maximum: PLAN.budgets.readAttempts, success: true}),
                observedIncidentalOrder: result.rows.map(row => row.key), successfulEnvelopeBytes: Buffer.byteLength(JSON.stringify(result))};
        });
        await caseRun('shared-key-and-kind-attempt-total', async () => {
            await assert.rejects(compose(async port => {await port.get('collection', 'a'); return {rows: await port.all('collection')};}, {...PLAN.budgets, readAttempts: 2}));
            const rows = trace.filter(row => row.phase === phase.name && row.event === 'started' && row.tagged);
            assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.comment.operation), ['key', 'kind']);
            verifyReadTrace(trace, phase.name, {attempts: 2, maximum: 2, operation: 'mixed'});
            const firstPhase = phase.name; phase = {...phase, name: firstPhase + '-successful'};
            const result = await compose(async port => ({value: await port.get('collection', 'a'), rows: await port.all('collection')}));
            assert.equal(result.value.rows.length, 3); verifyReadTrace(trace, phase.name, {maximum: PLAN.budgets.readAttempts, operation: 'mixed', success: true});
            return {rejectedAttemptCount: 2, completeValueBytes: Buffer.byteLength(JSON.stringify(result.value))};
        });
        for (const [name, totals] of [['attempt-overflow', {...PLAN.budgets, readAttempts: 1}],
            ['record-overflow', {...PLAN.budgets, responseRecords: 1}], ['serialized-byte-overflow', {...PLAN.budgets, responseBytes: 2}]]) {
            await caseRun(name, async () => {
                await assert.rejects(direct('collection', totals));
                const evidence = verifyReadTrace(trace, phase.name, {maximum: name === 'record-overflow' ? 2 : 1});
                assert.equal(evidence.dataAttempts, name === 'record-overflow' ? 2 : 1); return evidence;
            });
        }
        await caseRun('adaptive-retry-positive-control', async () => {
            await retry.connect(); await failpoint(retryName, 'find', 2, ['SystemOverloadedError', 'RetryableError']);
            const collection = 'bounded_stateful_v2_r_' + declaration.digest;
            const reply = await retry.db(options.database).command({find: collection, filter: {kind: 'empty'}, singleBatch: true, limit: 1},
                {signal: AbortSignal.timeout(PLAN.operationMS)}); assert.equal(reply.cursor.firstBatch.length, 0);
            const commands = trace.filter(row => row.phase === phase.name && row.event === 'started' && row.command === 'find');
            assert.equal(commands.length, 2, 'Positive control did not exercise a driver-hidden retry');
            assert.equal(trace.filter(row => row.phase === phase.name && row.event === 'failed').length, 1); return {actualCommandsForOneDriverCall: 2};
        });
        for (const command of ['find', 'getMore']) await caseRun('nonretrying-' + command + '-failure', async () => {
            arm(command, 2, ['SystemOverloadedError', 'RetryableError']);
            const maximum = command === 'find' ? 1 : 2;
            await assert.rejects(direct('collection', {...PLAN.budgets, readAttempts: maximum}));
            const evidence = verifyReadTrace(trace, phase.name, {maximum});
            assert.equal(evidence.dataAttempts, maximum);
            assert.equal(trace.filter(row => row.phase === phase.name && row.event === 'failed' && row.command === command).length, 1); return evidence;
        });
        for (const maximum of [1, PLAN.budgets.readAttempts]) await caseRun('callback-retry-total-' + maximum, async () => {
            arm('find', 112, ['TransientTransactionError']);
            if (maximum === 1) {await assert.rejects(direct('collection', {...PLAN.budgets, readAttempts: maximum}));
                return verifyReadTrace(trace, phase.name, {attempts: 1, maximum});}
            const result = await direct('collection', {...PLAN.budgets, readAttempts: maximum}); assert.equal(result.rows.length, 3);
            const evidence = verifyReadTrace(trace, phase.name, {attempts: result.attempts, maximum, success: true});
            assert.ok(evidence.dataAttempts >= 4); return evidence;
        });
        await caseRun('foreign-token-client-session-and-closed-read', async () => {
            const legacy = await ownerNative.createMongoDbStatefulOwnerAdapterV2({...config, client: admin}), expected = (await adapter.recovery()).view;
            const foreign = await legacy.completedRead(identity, expected, noCancel);
            try {await assert.rejects(adapter.readCompletedKind(foreign, expected, 'collection', PLAN.budgets));}
            finally {legacy.closeRead(foreign);}
            const local = await begin(), a = bounded.startSession(), b = admin.startSession();
            try {
                for (const session of [a, b]) await assert.rejects(session.withTransaction(() =>
                    internal.assertStatefulOwnerCompletedSnapshotV2(legacy, local.read, expected, session)));
                const legacyRead = await legacy.completedRead(identity, expected, noCancel);
                try {
                    for (const session of [a, b]) await assert.rejects(session.withTransaction(() =>
                        internal.assertStatefulOwnerCompletedSnapshotV2(legacy, legacyRead, expected, session)));
                    const issued = internal.createStatefulOwnerCompletedSessionV2(legacy);
                    await assert.rejects(internal.assertStatefulOwnerCompletedSnapshotV2(legacy, legacyRead, expected, issued));
                    await issued.endSession(); await assert.rejects(internal.assertStatefulOwnerCompletedSnapshotV2(legacy, legacyRead, expected, issued));
                } finally {legacy.closeRead(legacyRead);}
                adapter.closeRead(local.read); await assert.rejects(adapter.readCompletedKind(local.read, expected, 'collection', PLAN.budgets));
            } finally {adapter.closeRead(local.read); await a.endSession(); await b.endSession();}
            return verifyReadTrace(trace, phase.name, {attempts: 0, maximum: 0});
        });
        await caseRun('old-get-only-factory-current-sdk', async () => {
            const legacy = await ownerNative.createMongoDbStatefulOwnerAdapterV2({...config, client: admin}), expected = (await adapter.recovery()).view;
            assert.equal(legacy.completeKindCapabilities, undefined); const read = await legacy.completedRead(identity, expected, noCancel);
            try {const result = await legacy.readCompleted(read, expected, [{kind: 'collection', key: 'a'}]); assert.equal(result.results[0].value.name, 'a');}
            finally {legacy.closeRead(read);} return {getOnlyResult: 'present'};
        });
        await caseRun('cancellation-after-actual-data-response', async () => {
            let cancelled = false; afterData = async () => {afterData = undefined; cancelled = true;};
            await assert.rejects(compose(async port => ({rows: await port.all('collection')}), PLAN.budgets,
                () => {if (cancelled) throw new Error('qualification-cancelled');}));
            return verifyReadTrace(trace, phase.name, {attempts: 1, maximum: 1});
        });
        await caseRun('closed-plugin-port-and-advanced-final-view', async () => {
            let held; const result = await compose(async port => {held = port; return {rows: await port.all('collection')};});
            assert.equal(result.value.rows.length, 3); const count = trace.filter(row => row.event === 'started' && row.tagged).length;
            await assert.rejects(held.all('collection')); assert.equal(trace.filter(row => row.event === 'started' && row.tagged).length, count);
            await assert.rejects(compose(async port => {
                const rows = await port.all('collection'); const target = await raw(2);
                await apply(target, async write => {write.put('collection', 'a', {name: 'new-at-two'});}); return {rows};
            })); verifyReadTrace(trace, phase.name, {maximum: 2 * PLAN.budgets.readAttempts});
            return {closedPortRefused: true, changedFinalViewRefused: true};
        });
        await caseRun('raw-gap-restart-takeover-and-fork', async () => {
            const pending = await raw(3); await adapter.admitRaw(lease, pending);
            await adapter.markRawFailure(lease, pending.digest, 'synthetic raw gap');
            await assert.rejects(compose(async port => ({rows: await port.all('collection')})));
            const reopened = await native.createMongoDbStatefulCompleteKindAdapterV1(config, PLAN.budgets);
            await assert.rejects(reopened.completedRead(identity, (await reopened.recovery()).view, noCancel));
            await sdk.executeStatefulOwnerBlockV2(declaration, adapter, lease, pending.digest, sourceFor(pending), custody, async () => {}, noCancel);
            const candidate = [...custody.entries.values()].find(candidate => candidate.source.source.block.blockId === pending.target.block.blockId);
            assert.ok(candidate);
            await adapter.retireRaw(lease, pending.digest, candidate.source.digest, candidate.digest);
            const old = await begin(), recovery = await adapter.recovery(), oldIdentity = identity;
            identity = {...identity, generation: 'takeover'};
            lease = await adapter.acquireOwner({expected: {version: recovery.version, view: recovery.view, owner: recovery.owner}, nextOwner: identity}, noCancel);
            await assert.rejects(adapter.readCompletedKind(old.read, old.expected, 'collection', PLAN.budgets)); adapter.closeRead(old.read);
            await assert.rejects(adapter.completedRead(oldIdentity, (await adapter.recovery()).view, noCancel));
            const before = await adapter.recovery(), ancestor = {blockNum: 1, blockId: hex(1)};
            await adapter.rollbackOwned(lease, {declarationDigest: declaration.digest, revision: before.view.revision, operationId: hex(77),
                from: before.view.checkpoint, ancestor, maxBlocks: 2});
            const rolled = await adapter.recovery(); identity = {...identity, generation: 'fork'};
            lease = await adapter.acquireOwner({expected: {version: rolled.version, view: rolled.view, owner: rolled.owner}, nextOwner: identity}, noCancel);
            assert.notEqual(rolled.view.revision, before.view.revision);
            const replacement = await raw(2, 92); await apply(replacement, async port => {port.put('collection', 'a', {name: 'replacement-branch'});});
            phase = {name: phase.name + '-fresh-replacement'};
            const result = await direct('collection'); assert.equal(result.rows.find(row => row.key === 'a').value.name, 'replacement-branch');
            return {...verifyReadTrace(trace, phase.name, {attempts: result.attempts, maximum: PLAN.budgets.readAttempts, success: true}),
                persistedGapRefused: true, staleOwnerRefused: true, actualRollbackAndReplacement: true};
        });
        await caseRun('changed-declaration-refused', async () => {
            const changed = definition(logical, options.database); changed.binding.generation += '_other';
            const other = await sdk.captureStatefulOwnerDeclarationV2(await logical.captureStatefulDeclaration(changed, limits()), 2);
            const foreign = await native.createMongoDbStatefulCompleteKindAdapterV1({...config, declaration: other}, PLAN.budgets);
            await assert.rejects(foreign.recovery()); return {silentAdoption: false};
        });
    } catch (error) {reportError = error; report.failure = failure(error);}
    finally {
        phase = {name: 'cleanup'};
        const cleanup = {ownedDatabase: owned, databaseDropped: false, failpointDisabled: false, managedClientClosed: false}; report.cleanup = cleanup;
        try {if (failpointGranted) {await admin.db('admin').command({configureFailPoint: 'failCommand', mode: 'off'}); cleanup.failpointDisabled = true;}}
        catch (error) {reportError ??= error; cleanup.failpointError = failure(error);}
        try {await pool.close(); cleanup.managedClientClosed = closes.length === 1; assert.ok(cleanup.managedClientClosed);
            await assert.rejects(pool.get(PLAN.operationMS)); assert.ok(sessions.every(session => session.ended)); cleanup.sessions = sessions.length; cleanup.sessionsEnded = true;}
        catch (error) {reportError ??= error; cleanup.clientError = failure(error);}
        try {await retry.close();} catch (error) {reportError ??= error; cleanup.retryClientError = failure(error);}
        try {if (owned) {
            const marker = await admin.db(options.database).collection('_qualification_owner').findOne({_id: ownedMarker}); assert.equal(marker?.scope, PLAN.scope);
            await admin.db(options.database).dropDatabase({writeConcern: {w: 'majority', j: true}});
            assert.deepEqual(await admin.db(options.database).listCollections().toArray(), []); cleanup.databaseDropped = true;
        }} catch (error) {reportError ??= error; cleanup.databaseError = failure(error);}
        try {await admin.close();} catch (error) {reportError ??= error; cleanup.adminClientError = failure(error);}
        stopMonitor?.(); stopRetry();
        report.status = reportError ? 'failed' : 'passed-native-only'; report.traceEvents = trace.length;
        json(join(options.output, 'trace.json'), trace); json(join(options.output, 'report.json'), report);
        json(join(options.output, 'sha256.json'), ['trace.json', 'report.json'].map(path => ({path, sha256: hash(readFileSync(join(options.output, path)))})));
    }
    if (reportError) throw reportError; return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {const options = argumentsFor(process.argv.slice(2), process.env);
        if (options === null) console.log(JSON.stringify({status: 'inert-plan-only', ...PLAN}, null, 2));
        else {const report = await run(options); console.log(JSON.stringify({status: report.status, output: options.output}));}}
    catch (error) {console.error(JSON.stringify({status: 'failed', error: failure(error)})); process.exitCode = 1;}
}
