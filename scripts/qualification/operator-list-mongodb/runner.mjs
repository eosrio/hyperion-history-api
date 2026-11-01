// Explicit qualification only. Server/service management and process stops belong to the CI controller.
// Source admission uses read-only Git children; it creates no background worker/service.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {argumentsFor, failure, PLAN, sha, verifyReadTrace} from './contract.mjs';
import {installPublicationBarrier} from './cas-barrier.mjs';
import {inventory} from './inventory.mjs';
import {admitOperatorListAssembly} from './linux-source-profile.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), adapter = join(root, 'packages/backend-mongodb');
const require = createRequire(join(adapter, 'package.json'));
const rootRequire = createRequire(join(root, 'package.json'));
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
function sourceAdmission(options) {
    const assembly = admitOperatorListAssembly(PLAN.profile);
    const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
    assert.equal(git(['rev-parse', 'HEAD']), options.source);
    const scope = ['packages/backend-mongodb/src', 'packages/backend-mongodb/package.json', 'packages/backend-mongodb/package-lock.json',
        'scripts/qualification/operator-list-mongodb'];
    assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...scope]), '', 'Refuse dirty/untracked native qualification sources');
    const manifest = JSON.parse(readFileSync(join(adapter, 'package.json'))), lock = JSON.parse(readFileSync(join(adapter, 'package-lock.json')));
    assert.equal(manifest.dependencies.mongodb, PLAN.driver);
    assert.equal(manifest.devDependencies['@eosrio/hyperion-sdk'], 'git+https://github.com/eosrio/hyperion-sdk.git#' + PLAN.sdk);
    assert.ok(['git+https://github.com/eosrio/hyperion-sdk.git#' + PLAN.sdk, 'git+ssh://git@github.com/eosrio/hyperion-sdk.git#' + PLAN.sdk]
        .includes(lock.packages['node_modules/@eosrio/hyperion-sdk'].resolved));
    assert.equal(require('mongodb/package.json').version, PLAN.driver);
    assert.equal(rootRequire('mongodb/package.json').version, PLAN.driver);
    assert.equal(require('typescript/package.json').version, '7.0.2');
    const compiled = inventory(join(adapter, 'dist')), compiledSha256 = sha(JSON.stringify(compiled));
    assert.equal(compiledSha256, options.compiledSha256, 'Compiled artifact differs from the executor-reviewed fresh build');
    assert.match(process.version, /^v(?:24|26)\./);
    return {profile: PLAN.profile, assembly, commit: options.source, tree: git(['rev-parse', 'HEAD^{tree}']), nativeSources: inventory(join(adapter, 'src')),
        compiled, compiledSha256, sdkOperatorListSha256: sha(readFileSync(join(adapter, 'node_modules/@eosrio/hyperion-sdk/dist/operator-lists.js'))),
        sdk: PLAN.sdk, driver: PLAN.driver, runtime: {node: process.version, executable: process.execPath, executableSha256: sha(readFileSync(process.execPath))},
        compiler: '7.0.2', buildAdmission: 'Executor supplies the reviewed fresh-build inventory SHA; the hash alone is not compilation provenance'};
}
function monitor(client, database, phase, trace, late) {
    const pending = new Map();
    const start = event => {
        if (event.databaseName !== database && !['commitTransaction', 'abortTransaction', 'endSessions'].includes(event.commandName)) return;
        assert.ok(trace.length < 32768, 'Native trace bound exceeded'); const command = event.command;
        const row = {seq: trace.length, phase: phase(), client: 'bounded', event: 'started', requestId: event.requestId, command: event.commandName,
            collection: command.find ?? command.aggregate ?? command.collection ?? command.killCursors ?? command.insert ?? command.update ?? command.createIndexes ?? null,
            tagged: command.comment?.hyperion === 'operator-list-read-v1', lsid: command.lsid ? require('mongodb').BSON.serialize(command.lsid).toString('hex') : null,
            traceId: command.comment?.trace ?? null,
            txn: command.txnNumber?.toString() ?? null, transactional: command.autocommit === false, startsTransaction: command.startTransaction === true,
            readConcern: command.readConcern?.level ?? null, maxTimeMS: command.maxTimeMS ?? null,
            atClusterTime: command.readConcern?.atClusterTime ? require('mongodb').BSON.serialize({time: command.readConcern.atClusterTime}).toString('hex') : null,
            batchSize: command.batchSize ?? command.cursor?.batchSize ?? null, cursor: command.getMore?.toString() ?? null,
            writeConcern: command.writeConcern ?? null, commandBsonBytes: require('mongodb').BSON.calculateObjectSize(command)};
        pending.set(event.requestId, row); trace.push(row);
    };
    const finish = (event, success) => {
        const begin = pending.get(event.requestId); if (!begin) return; pending.delete(event.requestId);
        assert.ok(trace.length < 32768, 'Native trace bound exceeded'); const reply = event.reply, cursor = reply?.cursor;
        trace.push({seq: trace.length, phase: begin.phase, client: begin.client, event: success ? 'succeeded' : 'failed', requestId: event.requestId,
            command: begin.command, ...(success ? {replyBsonBytes: require('mongodb').BSON.calculateObjectSize(reply),
                ...(cursor ? {cursor: cursor.id.toString(), batch: (cursor.firstBatch ?? cursor.nextBatch).length,
                    snapshotTime: cursor.atClusterTime ? require('mongodb').BSON.serialize({time: cursor.atClusterTime}).toString('hex') : null} : {}),
                ...(['insert', 'update'].includes(begin.command) ? {matched: reply.n} : {}),
                ...(begin.command === 'killCursors' ? {cursorClosure: Object.fromEntries(['cursorsKilled', 'cursorsNotFound', 'cursorsAlive', 'cursorsUnknown']
                    .map(name => [name, reply[name]?.map(id => id.toString()) ?? null]))} : {})}
                : {error: failure(event.failure)})});
        if (success && begin.tagged) late(begin);
    };
    const success = event => finish(event, true), failed = event => finish(event, false);
    client.on('commandStarted', start); client.on('commandSucceeded', success); client.on('commandFailed', failed);
    return () => {client.off('commandStarted', start); client.off('commandSucceeded', success); client.off('commandFailed', failed);};
}

export async function run(options) {
    // Admission and output freshness precede MongoClient creation and every database/network effect.
    const source = sourceAdmission(options); options.output = resolve(options.output);
    assert.equal(existsSync(options.output), false); mkdirSync(options.output, {recursive: true});
    // Exercise the HAPI caller's driver/client copy through the adapter's own pinned executor.
    const {MongoClient} = rootRequire('mongodb'), sdk = await import(pathToFileURL(join(adapter, 'node_modules/@eosrio/hyperion-sdk/dist/operator-lists.js')));
    const {createMongoDbOperatorListSourceV1} = await import(pathToFileURL(join(adapter, 'dist/operator-lists.js')));
    const appName = options.database + '_bounded', marker = randomBytes(24).toString('hex'), trace = [], cases = [], sessions = [], sources = [];
    const config = {retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, maxPoolSize: 2, minPoolSize: 0,
        serverSelectionTimeoutMS: PLAN.operationMS, connectTimeoutMS: PLAN.operationMS, timeoutMS: PLAN.operationMS};
    const admin = new MongoClient(options.uri, {...config, appName: options.database + '_admin'});
    const bounded = new MongoClient(options.uri, {...config, appName, monitorCommands: true});
    const startSession = bounded.startSession.bind(bounded);
    bounded.startSession = (...args) => {
        const session = startSession(...args), end = session.endSession.bind(session), row = {ended: false}; sessions.push(row);
        session.endSession = async (...values) => {try {return await end(...values);} finally {row.ended = session.hasEnded;}}; return session;
    };
    let phase = 'preflight', owned = false, failpointGranted = false, late, original;
    const stopMonitor = monitor(bounded, options.database, () => phase, trace, row => late?.(row));
    const report = {schemaVersion: 1, plan: PLAN, source, database: options.database, cases,
        authority: 'Synthetic operator-owned native MongoDB qualification only; no chain, projection, HTTP, Atomic parity or Wire replay grant',
        accounting: {attempts: 'Every actual tagged find/aggregate/getMore/killCursors, including source/revision metadata, counts, headers, item pages and exhaustion',
            controls: 'No commit/abort machinery is used; publication writes/provisioning and external client endSessions are traced separately',
            bytes: 'Portable names once plus item occurrence UTF-8; native command/reply BSON is a distinct diagnostic total'}};
    const ctx = (ms = PLAN.readMS, changes = {}) => ({signal: new AbortController().signal, deadlineMS: performance.now() + ms, guard() {}, ...changes});
    const make = changes => {
        const source = createMongoDbOperatorListSourceV1({client: bounded, databaseName: options.database, collectionPrefix: 'bounded',
            binding: {chainId: 'a'.repeat(64), backendId: options.database, source: 'synthetic-schema-lists', generation: 'configured-one'},
            limits: PLAN.read, publicationLimits: PLAN.publication, cache: PLAN.cache, pageSize: PLAN.pageSize, batchDocuments: PLAN.batchDocuments,
            operationTimeoutMS: PLAN.operationMS, snapshotTimeoutMS: PLAN.snapshotMS, ...changes}); sources.push(source); return source;
    };
    const read = async (source, names, limits = PLAN.read, context = ctx()) => {
        const provider = source.createProvider(context); let raw;
        const observed = {capabilities: provider.capabilities, async read(...args) {raw = await provider.read(...args); return raw;}};
        try {
            const selection = sdk.negotiateOperatorListsV1(limits, source.capabilities, observed.capabilities);
            const result = await sdk.readOperatorListsV1(selection, observed, names, source.binding.source, source.binding.generation, provider.assertCurrent);
            provider.assertCurrent(); const metrics = verifyReadTrace(trace, phase, {attempts: raw.attempts, maximum: limits.attempts, success: true});
            return {result, raw, metrics};
        } finally {provider.close();}
    };
    const caseRun = async (name, work) => {
        phase = name; const started = performance.now(), from = trace.length, usage = process.cpuUsage();
        try {const result = await work(); cases.push({name, status: 'passed', elapsedMS: performance.now() - started,
            cpuMicroseconds: process.cpuUsage(usage), rssBytes: process.memoryUsage().rss, trace: [from, trace.length], ...result});}
        catch (error) {cases.push({name, status: 'failed', elapsedMS: performance.now() - started, trace: [from, trace.length], error: failure(error)}); throw error;}
        finally {late = undefined;}
    };
    const fail = error => error?.code === 'operator-list.unavailable' && error.retryable === true;
    try {
        await admin.connect(); const hello = await admin.db('admin').command({hello: 1}), build = await admin.db('admin').command({buildInfo: 1});
        assert.equal(hello.isWritablePrimary, true); assert.equal(hello.setName, options.replicaSet); assert.equal(hello.me, options.member);
        assert.deepEqual(hello.hosts, [options.member]); assert.equal(build.version, PLAN.server); report.server = {version: build.version, replicaSet: hello.setName, member: hello.me};
        const failpoint = await admin.db('admin').command({getParameter: 1, 'failpoint.failCommand': 1});
        assert.equal(failpoint['failpoint.failCommand'].mode, 0, 'Refuse a previously armed shared failpoint'); failpointGranted = true;
        const db = admin.db(options.database); assert.deepEqual(await db.listCollections().toArray(), [], 'Refuse nonempty database');
        await db.collection('_qualification_owner').insertOne({_id: marker, scope: PLAN.scope}, {writeConcern: {w: 'majority', j: true}}); owned = true;
        await bounded.connect(); const source = make();
        const schema = {name: 'schemas', items: ['one', 'two', 'two', 'é', '😀']};
        const bulk = Array.from({length: 40}, (_, list) => ({name: 'bulk-' + list,
            items: Array.from({length: 512}, (_, i) => 'v'.repeat(1010) + String(list * 512 + i).padStart(14, '0'))}));
        await caseRun('partitioned-publication-over-16MiB', async () => {
            const receipt = await source.publish({revision: 'one', expectedRevision: null, entries: [...bulk, schema, {name: 'empty', items: []}]}, ctx(PLAN.publicationMS));
            assert.ok(receipt.bytes > 16 * 1024 * 1024); assert.equal(receipt.items, 40 * 512 + 5);
            assert.equal(receipt.attempts, trace.filter(row => row.phase === phase && row.event === 'started').length);
            const verification = verifyReadTrace(trace, phase, {maximum: PLAN.publication.attempts, success: true});
            return {receipt, verification, singleWholeSourceBsonDocument: false, realDatasetUtf8Bytes: receipt.bytes};
        });
        await caseRun('actual-attempts-and-exhaustion', async () => {
            const value = await read(source, ['bulk-0', 'schemas', 'empty', 'absent']);
            assert.deepEqual(value.result.entries, [bulk[0], schema, {name: 'empty', items: []}, {name: 'absent', items: []}]);
            assert.ok(trace.some(row => row.phase === phase && row.event === 'started' && row.command === 'getMore'));
            return value.metrics;
        });
        await caseRun('cleanup-attempt-reserve', async () => {
            phase = 'cleanup-attempt-reserve-baseline'; const baseline = await read(make(), ['bulk-1']);
            phase = 'cleanup-attempt-reserve-bounded';
            await assert.rejects(read(make(), ['bulk-1'], {...PLAN.read, attempts: baseline.raw.attempts}), fail);
            const metrics = verifyReadTrace(trace, phase, {maximum: baseline.raw.attempts});
            const cleanup = trace.filter(row => row.phase === phase && row.event === 'succeeded' && row.command === 'killCursors');
            assert.equal(cleanup.length, 1); assert.ok(cleanup[0].cursorClosure.cursorsKilled.length + cleanup[0].cursorClosure.cursorsNotFound.length > 0);
            assert.deepEqual(cleanup[0].cursorClosure.cursorsAlive, []); assert.deepEqual(cleanup[0].cursorClosure.cursorsUnknown, []);
            return {baseline: baseline.metrics, bounded: metrics, physicalCursorClosure: cleanup[0].cursorClosure};
        });
        await caseRun('ordinary-revision-cache', async () => {
            await source.publish({revision: 'two', expectedRevision: 'one', entries: [{name: 'schemas', items: ['replacement']}]}, ctx(PLAN.publicationMS));
            // Publication verification is not a portable read; isolate its trace phase before checking cache attempts.
            phase = 'ordinary-revision-cache-hit'; const value = await read(source, ['bulk-0', 'schemas']);
            assert.equal(value.raw.attempts, 0); assert.deepEqual(value.result.entries, [bulk[0], schema]);
            phase = 'ordinary-revision-cache-cold'; const fresh = await read(make(), ['bulk-0', 'schemas']);
            assert.deepEqual(fresh.result.entries, [{name: 'bulk-0', items: []}, {name: 'schemas', items: ['replacement']}]);
            return {cache: value.metrics, cold: fresh.metrics, ordinaryDataRevisionDoesNotRetireConfig: true};
        });
        await caseRun('empty-missing-and-unavailable', async () => {
            const value = await read(make(), ['missing']); assert.deepEqual(value.result.entries, [{name: 'missing', items: []}]);
            const other = make({binding: {...source.binding, generation: 'unprovisioned'}});
            phase = 'empty-missing-and-unavailable-unprovisioned'; await assert.rejects(read(other, ['missing']), fail);
            return {completeMissing: true, unavailable: verifyReadTrace(trace, phase, {maximum: PLAN.read.attempts})};
        });
        await caseRun('whole-read-budgets', async () => {
            await assert.rejects(read(make(), ['schemas'], {...PLAN.read, items: 0}), fail);
            phase = 'whole-read-budgets-attempts'; await assert.rejects(read(make(), ['schemas'], {...PLAN.read, attempts: 4}), fail);
            const metrics = verifyReadTrace(trace, phase, {maximum: 4});
            phase = 'whole-read-budgets-bytes'; await assert.rejects(read(make(), ['schemas'], {...PLAN.read, bytes: 7}), fail);
            return {attempts: metrics, itemsAndUtf8Refused: true};
        });
        await caseRun('missing-index-native-failure', async () => {
            await db.collection('bounded_ol_v1_item').dropIndex('h45_operator_list_items_v1');
            try {await assert.rejects(read(make(), ['schemas']), fail);}
            finally {await db.collection('bounded_ol_v1_item').createIndex({slot: 1, revision: 1, list: 1, ordinal: 1},
                {name: 'h45_operator_list_items_v1', unique: true, collation: {locale: 'simple'}});}
            const metrics = verifyReadTrace(trace, phase, {maximum: PLAN.read.attempts});
            assert.ok(trace.some(row => row.phase === phase && row.event === 'failed')); return metrics;
        });
        await caseRun('partial-storage-refusal', async () => {
            const current = await db.collection('bounded_ol_v1_source').findOne({}), header = await db.collection('bounded_ol_v1_header').findOne({revision: current.revision, name: 'schemas'});
            const item = await db.collection('bounded_ol_v1_item').findOne({list: header._id}); assert.ok(item);
            await db.collection('bounded_ol_v1_item').deleteOne({_id: item._id});
            try {await assert.rejects(read(make(), ['missing']), fail);}
            finally {await db.collection('bounded_ol_v1_item').insertOne(item, {writeConcern: {w: 'majority', j: true}});}
            return verifyReadTrace(trace, phase, {maximum: PLAN.read.attempts});
        });
        await caseRun('concurrent-publication-and-losing-CAS', async () => {
            // Actual concurrent writers with the same expected pointer; no receipt grants a winner.
            const barrier = installPublicationBarrier(bounded, options.database, 'two', ['left', 'right']); let outcomes;
            try {outcomes = await Promise.allSettled(['left', 'right'].map(revision => make().publish({revision, expectedRevision: 'two',
                entries: [{name: 'schemas', items: [revision]}]}, ctx(PLAN.publicationMS))));}
            finally {barrier.close();}
            assert.equal(barrier.arrived.size, 2, 'Both verified complete revisions must reach the actual CAS boundary');
            assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
            assert.equal(outcomes.filter(value => value.status === 'rejected' && fail(value.reason)).length, 1);
            const cas = trace.filter(row => row.phase === phase && row.event === 'started' && row.command === 'update' && row.collection === 'bounded_ol_v1_source');
            assert.equal(cas.length, 2);
            assert.deepEqual(cas.map(row => trace.find(item => item.event === 'succeeded' && item.requestId === row.requestId)?.matched).sort(), [0, 1]);
            const published = await db.collection('bounded_ol_v1_source').findOne({}); assert.ok(['left', 'right'].includes(published.revision));
            phase = 'concurrent-publication-and-losing-CAS-read'; const value = await read(make(), ['schemas']);
            assert.deepEqual(value.result.entries[0].items, [published.revision]);
            const retained = await db.collection('bounded_ol_v1_revision').find({revision: {$in: ['left', 'right']}}).toArray();
            assert.equal(retained.length, 2); assert.ok(retained.every(row => row.complete === true));
            return {winner: published.revision, retainedRevisions: retained.map(row => ({revision: row.revision, complete: row.complete})), coherentRead: value.metrics};
        });
        await caseRun('late-cancel-and-retirement', async () => {
            const abort = new AbortController(), cancelled = make(); let cancelledAfterResponse = false, retiredAfterResponse = false;
            late = () => {late = undefined; cancelledAfterResponse = true; abort.abort();};
            await assert.rejects(read(cancelled, ['schemas'], PLAN.read, ctx(PLAN.readMS, {signal: abort.signal})), fail); assert.equal(cancelledAfterResponse, true);
            phase = 'late-cancel-and-retirement-retry'; const recovered = await read(cancelled, ['schemas']); assert.ok(recovered.raw.attempts > 0);
            phase = 'late-cancel-and-retirement-config'; const retired = make(); late = () => {late = undefined; retiredAfterResponse = true; retired.retire();};
            await assert.rejects(read(retired, ['schemas']), fail);
            assert.equal(retiredAfterResponse, true);
            return {actualSuccessfulNativeResponsePrecededRefusal: true, cancelledReadNotCached: true, configRetirementRefused: true};
        });
        await caseRun('blocked-find-deadline', async () => {
            await admin.db('admin').command({configureFailPoint: 'failCommand', mode: {times: 1},
                data: {failCommands: ['find'], appName, blockConnection: true, blockTimeMS: 200}});
            const started = performance.now();
            try {await assert.rejects(read(make(), ['schemas'], PLAN.read, ctx(50)), fail);}
            finally {await admin.db('admin').command({configureFailPoint: 'failCommand', mode: 'off'});}
            const elapsedMS = performance.now() - started;
            assert.ok(trace.some(row => row.phase === phase && row.event === 'started' && row.command === 'find' && row.tagged), 'Deadline case must dispatch the actual blocked find');
            return {...verifyReadTrace(trace, phase, {maximum: PLAN.read.attempts}), deadlineMS: 50, terminalIncludingDriverCleanupMS: elapsedMS,
                note: 'Cleanup timing is measured separately; no successful response after deadline is admitted'};
        });
    } catch (error) {original = error; report.failure = failure(error);}
    finally {
        phase = 'original-session-client-cleanup'; late = undefined;
        const cleanup = report.cleanup = {ownedDatabase: owned, failpointDisabled: false, sessionsEnded: false, boundedClosed: false, ownedDatabaseDropped: false, adminClosed: false};
        for (const source of sources) source.retire();
        const retain = (name, error) => {original ??= error; cleanup[name] = failure(error);};
        try {if (failpointGranted) {await admin.db('admin').command({configureFailPoint: 'failCommand', mode: 'off'}); cleanup.failpointDisabled = true;}}
        catch (error) {retain('failpointError', error);}
        try {await bounded.close(); cleanup.boundedClosed = true; assert.ok(sessions.every(row => row.ended)); cleanup.sessionsEnded = true; cleanup.sessions = sessions.length;
            assert.equal(trace.filter(row => row.event === 'started' && ['commitTransaction', 'abortTransaction'].includes(row.command)).length, 0); cleanup.noHiddenTransactionControls = true;}
        catch (error) {retain('boundedError', error);}
        try {if (owned) {
            const db = admin.db(options.database), stored = await db.collection('_qualification_owner').findOne({_id: marker}); assert.equal(stored?.scope, PLAN.scope);
            await db.dropDatabase({writeConcern: {w: 'majority', j: true}}); assert.deepEqual(await db.listCollections().toArray(), []); cleanup.ownedDatabaseDropped = true;
        }} catch (error) {retain('databaseError', error);}
        try {await admin.close(); cleanup.adminClosed = true;} catch (error) {retain('adminError', error);}
        stopMonitor(); report.status = original ? 'failed' : 'passed-native-only'; report.traceEvents = trace.length;
        json(join(options.output, 'trace.json'), trace); json(join(options.output, 'report.json'), report);
        json(join(options.output, 'sha256.json'), ['trace.json', 'report.json'].map(path => ({path, bytes: readFileSync(join(options.output, path)).length,
            sha256: sha(readFileSync(join(options.output, path)))})));
    }
    if (original) throw original; return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {const report = await run(argumentsFor(process.argv.slice(2), process.env)); console.log(JSON.stringify({status: report.status}));}
    catch (error) {console.error(JSON.stringify({status: 'failed', error: failure(error)})); process.exitCode = 1;}
}
