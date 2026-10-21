import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MongoClient} from 'mongodb';
import {validateWorkerJob} from './projection-rollback-worker.mjs';

const workerPath = fileURLToPath(new URL('./projection-rollback-worker.mjs', import.meta.url));
const repositoryPath = fileURLToPath(new URL('../../', import.meta.url));
const zero = '0'.repeat(64);
const genesis = {blockNum: 0, blockId: zero};
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value !== null && typeof value === 'object'
    ? (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
        : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`)
    : JSON.stringify(value);
const checkpoint = block => ({blockNum: block.blockNum, blockId: block.blockId});
const key = value => JSON.stringify(['scope', value]);
const record = (id, owner, amount) => ({key: key(id), value: {owner, amount, enabled: true, note: null}});
const sorted = rows => copy(rows).sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
const errorCode = code => error => error?.code === code;
const all = {filter: [], limit: 1000};

/** A private runner seam: resources are already owned, and only this child handle can be killed. */
export async function runRollbackWorker(job, {assertOwned, children = new Set(), processes = [], timeoutMS = 120_000} = {}) {
    assert.equal(typeof assertOwned, 'function', 'The fixture owner must prove ownership before launching a worker');
    assertOwned();
    validateWorkerJob(job);
    assert.ok(Number.isSafeInteger(timeoutMS) && timeoutMS >= 100 && timeoutMS <= 180_000);
    const child = spawn(process.execPath, [workerPath, '--ipc-worker'], {
        cwd: repositoryPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    children.add(child);
    const started = Date.now();
    let stdout = '', stderr = '', envelope, timedOut = false, overflow = false;
    const kill = () => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');};
    const timer = setTimeout(() => {timedOut = true; kill();}, timeoutMS);
    const collect = (kind, chunk) => {
        if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 256 * 1024) {overflow = true; kill();}
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('message', message => {
        if (envelope !== undefined || Buffer.byteLength(JSON.stringify(message)) > 12 * 1024 * 1024) {
            overflow = true; kill(); return;
        }
        envelope = message;
    });
    let closed;
    try {
        closed = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({code, signal}));
            child.send(job, error => {if (error) {kill(); reject(error);}});
        });
    } finally {
        clearTimeout(timer);
        children.delete(child);
    }
    const lines = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const barrier = lines.find(line => line.type === 'barrier');
    const entry = {action: job.action, crash: job.crash ?? null, pid: barrier?.pid ?? envelope?.value?.pid ?? child.pid,
        node: barrier?.node ?? envelope?.value?.node ?? null, elapsedMS: Date.now() - started,
        exitCode: closed.code, signal: closed.signal, barrier: barrier ?? null,
        trace: envelope?.value?.trace ?? [], stderr};
    processes.push(entry);
    assert.equal(timedOut, false, 'Owned rollback worker exceeded its deadline');
    assert.equal(overflow, false, 'Owned rollback worker exceeded its evidence budget');
    if (job.crash) {
        assert.equal(closed.signal, 'SIGKILL', `Worker did not crash at ${job.crash}: ${JSON.stringify(envelope)}`);
        assert.equal(barrier?.boundary, job.crash, 'Actual durable boundary was not observed before SIGKILL');
        assert.equal(envelope, undefined, 'Crashed worker unexpectedly acknowledged completion');
        return {barrier, process: entry};
    }
    assert.equal(closed.code, 0, `Worker failed: ${JSON.stringify(envelope)} ${stderr}`);
    assert.equal(closed.signal, null);
    assert.equal(envelope?.type, 'result', 'Independent worker did not return a result');
    return envelope.value;
}

/**
 * Actual MongoDB + native child processes; caller owns service creation and cleanup.
 * There is deliberately no CLI accepting a MongoDB URI or existing operator database.
 */
export async function runProjectionRollbackQualification({uri, databaseName, run, assertOwned}) {
    assert.equal(process.platform, 'linux', 'Process-crash fixture requires Linux');
    assert.equal(process.release.name, 'node');
    assert.ok(['22', '24'].includes(process.versions.node.split('.')[0]), 'Use native Node.js 22 or 24');
    assert.match(run, /^[0-9a-f]{32}$/);
    assert.equal(typeof assertOwned, 'function');
    assertOwned();
    const {createMongoDbProjectionAdapter, createMongoDbRollbackAdapter} = await import('../../packages/backend-mongodb/dist/index.js');
    const {RecoverableProjectionRuntime} = await import('../../build/indexer/projection/recoverable-runtime.js');
    const {DeclarativeProjectionRuntime} = await import('../../build/indexer/projection/runtime.js');
    const prefix = 'h45_rollback', backendId = `rollback-${run}`, chainId = hash(`projection-rollback:${run}`);
    const children = new Set(), processes = [];
    const cancelChildren = () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    process.on('SIGINT', cancelChildren);
    process.on('SIGTERM', cancelChildren);
    const report = {schemaVersion: 1, status: 'running', qualification: false, run, node: process.version,
        scope: 'SDK v2 and shared declarative runtime/adapter process-crash rollback; no live SHiP fork or release qualification',
        checks: [], processes, cleanup: {children: false, client: false}};
    const client = new MongoClient(uri, {appName: `h45-rollback-oracle-${run}`, directConnection: true,
        retryWrites: false, maxPoolSize: 4, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, timeoutMS: 30_000});
    const check = (name, details) => report.checks.push({name, ...(details === undefined ? {} : {details})});
    const rootOptions = {client, databaseName, backendId, collectionPrefix: prefix,
        operationTimeoutMS: 30_000, transactionTimeoutMS: 60_000};
    const block = (branch, number) => ({blockNum: number, blockId: hash(`block:${branch}:${number}`),
        previousBlockId: number === 1 ? zero : hash(`block:${number === 2 ? 'common' : branch}:${number - 1}`)});
    const firstBlock = block('common', 1);
    const definitionFor = name => ({schemaVersion: 1, id: `rollback-${run}-${name}`, mappingRevision: 'c'.repeat(64),
        source: {contract: 'fixture.items', table: 'inventory', abiDeployment: 'fixture:deployment:1', abiSha256: 'd'.repeat(64)},
        fields: [{name: 'owner', path: ['owner'], type: 'string'}, {name: 'amount', path: ['amount'], type: 'integer'},
            {name: 'enabled', path: ['enabled'], type: 'boolean'}, {name: 'note', path: ['note'], type: 'null'}],
        initialization: {kind: 'genesis'}});
    const bindingFor = definition => ({chainId, backendId, projectionId: definition.id, mappingRevision: definition.mappingRevision,
        abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256, generation: 'rollback-fixture-instance-1'});
    const change = (id, owner, amount, present = true) => ({contract: 'fixture.items', table: 'inventory', scope: 'scope',
        primaryKey: id, abiDeployment: 'fixture:deployment:1', abiSha256: 'd'.repeat(64), present,
        ...(present ? {value: {owner, amount, enabled: true, note: null}} : {})});
    const frame = (branch, number, changes) => ({chainId, block: number === 1 ? firstBlock : block(branch, number), changes});
    const first = frame('common', 1, [change('survivor', 'alice', 100), change('update', 'bob', 200),
        change('delete', 'carol', 300), change('repeat', 'dora', 10)]);
    const orphan2 = frame('orphan', 2, [change('insert', 'orphan', 400), change('update', 'bob', 201),
        change('delete', '', 0, false), change('repeat', 'orphan', 20), change('repeat', '', 0, false), change('repeat', 'orphan', 30)]);
    const orphan3 = frame('orphan', 3, [change('survivor', '', 0, false), change('insert', 'orphan', 401), change('second', 'orphan', 500)]);
    const orphan4 = frame('orphan', 4, [change('update', 'orphan', 204), change('repeat', '', 0, false), change('absent', '', 0, false)]);
    const replacement2 = frame('replacement', 2, [change('update', 'canonical', 900), change('delete', '', 0, false),
        change('replacement', 'canonical', 600), change('repeat', '', 0, false), change('repeat', 'canonical', 777)]);
    const replacement3 = frame('replacement', 3, [change('survivor', 'canonical', 901), change('insert', '', 0, false)]);
    const replacement4 = frame('replacement', 4, []);
    const baseRows = sorted([record('survivor', 'alice', 100), record('update', 'bob', 200), record('delete', 'carol', 300), record('repeat', 'dora', 10)]);
    const orphanRows2 = sorted([record('survivor', 'alice', 100), record('update', 'bob', 201), record('insert', 'orphan', 400), record('repeat', 'orphan', 30)]);
    const orphanRows3 = sorted([record('update', 'bob', 201), record('insert', 'orphan', 401), record('second', 'orphan', 500), record('repeat', 'orphan', 30)]);
    const orphanRows4 = sorted([record('update', 'orphan', 204), record('insert', 'orphan', 401), record('second', 'orphan', 500)]);
    const replacementRows = sorted([record('survivor', 'canonical', 901), record('update', 'canonical', 900),
        record('repeat', 'canonical', 777), record('replacement', 'canonical', 600)]);
    const scenario = async (name, adapterOptions = {}) => {
        const definition = definitionFor(name), binding = bindingFor(definition);
        const adapter = createMongoDbRollbackAdapter({...rootOptions, ...adapterOptions});
        const runtime = await RecoverableProjectionRuntime.create({adapter, definition, binding, genesis});
        const job = {schemaVersion: 1, uri, databaseName, collectionPrefix: prefix, backendId, definition, binding, adapterOptions};
        return {definition, binding, adapter, runtime, job, adapterOptions};
    };
    const worker = (selected, action, extra = {}) => runRollbackWorker({...selected.job, action, ...extra}, {assertOwned, children, processes});
    const metadata = selected => client.db(databaseName).collection(`${prefix}_metadata`).findOne({'binding.projectionId': selected.binding.projectionId});
    const physical = async (selected, expectedCheckpoint, expectedRows) => {
        const value = await metadata(selected);
        assert.ok(value);
        const plainCheckpoint = checkpoint(value.checkpoint);
        assert.deepEqual(plainCheckpoint, expectedCheckpoint);
        if (value.storageVersion === 'h45-portable-mongodb-v2') {
            assert.deepEqual(Object.keys(value.checkpoint).sort(), ['blockId', 'blockNum', 'revision']);
            assert.equal(value.checkpoint.revision, value.revision, 'Native checkpoint CAS must fence pre-upgrade legacy writers');
        } else assert.deepEqual(Object.keys(value.checkpoint).sort(), ['blockId', 'blockNum']);
        const documents = await client.db(databaseName).collection(`${prefix}_r_${hash(canonical(selected.binding))}`)
            .find({}).sort({_id: 1}).toArray();
        const rows = documents.map(document => ({key: document._id, value: document.value}));
        assert.deepEqual(rows, expectedRows);
        return {checkpoint: plainCheckpoint, rows: rows.length, rowSha256: hash(canonical(rows)),
            revision: value.revision, pending: value.pending !== null, rollback: value.rollback?.status ?? null};
    };
    const prepareOrphan = async selected => {
        await selected.runtime.process(first);
        const firstView = await selected.runtime.open();
        await selected.runtime.process(orphan2); await selected.runtime.process(orphan3); await selected.runtime.process(orphan4);
        await physical(selected, checkpoint(orphan4.block), orphanRows4);
        return firstView;
    };
    const reopen = async selected => RecoverableProjectionRuntime.create({
        adapter: createMongoDbRollbackAdapter({...rootOptions, ...selected.adapterOptions}), definition: selected.definition, binding: selected.binding, genesis});
    const resumeRollback = async (selected, request) => {
        let value;
        for (let attempts = 0; attempts < 8; attempts++) {
            value = await worker(selected, 'rollback', {request: {...request, maxBlocks: 1}});
            if (value.result.status !== 'in-progress') return value;
            await assert.rejects(selected.adapter.open(selected.binding), errorCode('projection.incomplete'));
        }
        throw new Error('Rollback did not complete within its bounded fixture steps');
    };
    try {
        await client.connect();
        const build = await client.db('admin').command({buildInfo: 1});
        assert.equal(build.version, '8.0.34');
        report.server = {version: build.version, gitVersion: build.gitVersion};
        const independent = await scenario('unrelated');
        await independent.runtime.process(frame('common', 1, [change('independent', 'operator', 777)]));
        const independentRows = [record('independent', 'operator', 777)];
        const assertIndependent = async () => assert.deepEqual((await independent.runtime.query(all)).rows, independentRows);

        for (const boundary of ['after-apply-intent', 'before-apply-commit', 'after-apply-commit']) {
            const selected = await scenario(boundary);
            await selected.runtime.process(first);
            const crashed = await worker(selected, 'process', {frame: orphan2, crash: boundary});
            const committed = boundary === 'after-apply-commit';
            const beforeRestart = await physical(selected, checkpoint(committed ? orphan2.block : firstBlock), committed ? orphanRows2 : baseRows);
            const inspection = await worker(selected, 'inspect');
            assert.notEqual(inspection.pid, crashed.barrier.pid);
            if (!committed) {
                assert.equal(inspection.result.query.error, 'projection.incomplete');
                assert.equal(inspection.recovery.pending.block.blockId, orphan2.block.blockId);
                assert.match(inspection.recovery.pending.digest, /^[0-9a-f]{64}$/);
            } else assert.deepEqual(inspection.result.query.rows, orphanRows2);
            const replay = await worker(selected, 'process', {frame: orphan2});
            assert.equal(replay.result.status, committed ? 'duplicate' : 'applied');
            const afterRestart = await physical(selected, checkpoint(orphan2.block), orphanRows2);
            await assertIndependent();
            check(`native worker SIGKILL ${boundary}; fresh process resumes exact apply/checkpoint`, {beforeRestart, afterRestart});
        }

        for (const boundary of ['after-rollback-intent', 'after-rollback-step']) {
            const selected = await scenario(boundary);
            await prepareOrphan(selected);
            const request = {operationId: `${boundary}-${run}`, ancestor: checkpoint(firstBlock), maxBlocks: 1};
            const crashed = await worker(selected, 'rollback', {request, crash: boundary});
            const undoCommitted = boundary === 'after-rollback-step';
            const beforeRestart = await physical(selected, checkpoint(undoCommitted ? orphan3.block : orphan4.block),
                undoCommitted ? orphanRows3 : orphanRows4);
            const inspection = await worker(selected, 'inspect');
            assert.notEqual(inspection.pid, crashed.barrier.pid);
            assert.equal(inspection.result.query.error, 'projection.incomplete');
            assert.equal(inspection.recovery.rollback.status, 'running');
            await assertIndependent();
            const resumed = await resumeRollback(selected, request);
            assert.equal(resumed.result.status, 'rolled-back');
            const afterRestart = await physical(selected, checkpoint(firstBlock), baseRows);
            assert.deepEqual((await worker(selected, 'inspect')).result.query.rows, baseRows);
            check(`native worker SIGKILL ${boundary}; independent processes resume one-block undo`, {beforeRestart, afterRestart});
        }

        const canonical = await scenario('canonical');
        const oldAncestorView = await prepareOrphan(canonical);
        const oldHeadView = await canonical.runtime.open();
        const operation = {operationId: `canonical-${run}`, ancestor: checkpoint(firstBlock), maxBlocks: 256};
        await worker(canonical, 'rollback', {request: operation, crash: 'after-result'});
        const rolledBack = await physical(canonical, checkpoint(firstBlock), baseRows);
        assert.notEqual(rolledBack.revision, oldAncestorView.revision);
        await assert.rejects(canonical.adapter.query(oldAncestorView, all), errorCode('projection.stale-revision'));
        await assert.rejects(canonical.adapter.markIncomplete({binding: canonical.binding, revision: oldHeadView.revision,
            block: replacement2.block, reason: 'stale owner'}), errorCode('projection.stale-revision'));
        await assert.rejects(canonical.runtime.process(replacement2), errorCode('projection.stale-revision'));
        canonical.runtime = await reopen(canonical);
        await canonical.runtime.process(replacement2); await canonical.runtime.process(replacement3); await canonical.runtime.process(replacement4);
        const replaced = await physical(canonical, checkpoint(replacement4.block), replacementRows);
        assert.notEqual(replaced.checkpoint.blockId, oldHeadView.checkpoint.blockId);
        const duplicateRecovery = await worker(canonical, 'rollback', {request: operation});
        assert.equal(duplicateRecovery.result.status, 'duplicate');
        assert.deepEqual(duplicateRecovery.recovery.checkpoint, checkpoint(replacement4.block));
        assert.equal((await canonical.runtime.process(replacement2)).status, 'duplicate');
        await assert.rejects(canonical.runtime.process(orphan4), errorCode('projection.conflicting-replay'));
        await physical(canonical, checkpoint(replacement4.block), replacementRows);
        await assertIndependent();
        check('lost rollback response, same-height replacement, first-image CRUD undo, stale views/writers and exact duplicates', {rolledBack, replaced});

        const cancelled = await scenario('same-checkpoint');
        await cancelled.runtime.process(first);
        const beforeGap = await cancelled.runtime.open();
        await assert.rejects(cancelled.runtime.process(orphan3), errorCode('projection.source-gap'));
        assert.equal((await cancelled.runtime.recovery()).gap.block.blockNum, 3);
        await assert.rejects(cancelled.runtime.open(), errorCode('projection.incomplete'));
        assert.equal((await cancelled.runtime.rollback({operationId: `cancel-gap-${run}`, ancestor: checkpoint(firstBlock), maxBlocks: 1})).status, 'rolled-back');
        await assert.rejects(cancelled.adapter.query(beforeGap, all), errorCode('projection.stale-revision'));
        const invalid = copy(orphan2); invalid.changes[0].value.owner = 123;
        await assert.rejects(cancelled.runtime.process(invalid), errorCode('projection.invalid-contract'));
        assert.equal((await cancelled.runtime.recovery()).pending.block.blockNum, 2);
        assert.equal((await cancelled.runtime.rollback({operationId: `cancel-pending-${run}`, ancestor: checkpoint(firstBlock), maxBlocks: 1})).status, 'rolled-back');
        assert.deepEqual((await cancelled.runtime.query(all)).rows, baseRows);
        await physical(cancelled, checkpoint(firstBlock), baseRows);
        await assertIndependent();
        check('exact same-checkpoint recovery fences and cancels orphan pending/gap without inventing progress');

        const window = await scenario('window', {rollbackRetentionBlocks: 2});
        await prepareOrphan(window);
        const retained = await window.runtime.recovery();
        assert.equal(retained.coverage.retainedBlocks, 2);
        assert.deepEqual(retained.coverage.floor, checkpoint(orphan2.block));
        await assert.rejects(window.runtime.rollback({operationId: `window-${run}`, ancestor: checkpoint(firstBlock), maxBlocks: 1}),
            errorCode('projection.rollback-unavailable'));
        const uncovered = await window.runtime.recovery();
        assert.equal(uncovered.rollback.status, 'unavailable');
        assert.deepEqual(uncovered.checkpoint, checkpoint(orphan4.block));
        await assert.rejects(window.runtime.open(), errorCode('projection.incomplete'));
        const windowRestart = await worker(window, 'inspect');
        assert.equal(windowRestart.recovery.rollback.status, 'unavailable');
        assert.equal(windowRestart.result.query.error, 'projection.incomplete');
        await physical(window, checkpoint(orphan4.block), orphanRows4);
        await assertIndependent();
        check('bounded block window rejects an older exact ancestor and remains incomplete across worker restart', {coverage: retained.coverage});

        const wrongBranch = await scenario('wrong-branch');
        await prepareOrphan(wrongBranch);
        await assert.rejects(wrongBranch.runtime.rollback({operationId: `wrong-branch-${run}`,
            ancestor: {blockNum: 2, blockId: hash('not-the-retained-block')}, maxBlocks: 1}), errorCode('projection.rollback-unavailable'));
        await assert.rejects(wrongBranch.runtime.open(), errorCode('projection.incomplete'));
        await physical(wrongBranch, checkpoint(orphan4.block), orphanRows4);
        check('same-height wrong branch identity cannot select a retained ancestor');

        const byteOptions = {rollbackRetentionBlocks: 64, rollbackRetentionBytes: 7000, rollbackMaxBlockBytes: 7000};
        const byteWindow = await scenario('byte-window', byteOptions);
        const payload = 'b'.repeat(2500);
        for (let number = 1; number <= 7; number++) await byteWindow.runtime.process(frame('orphan', number, [change('large', payload, number)]));
        const byteRecovery = await byteWindow.runtime.recovery();
        assert.ok(byteRecovery.coverage.retainedBytes <= 7000);
        assert.ok(byteRecovery.coverage.floor.blockNum > 0);
        assert.ok(byteRecovery.coverage.retainedBlocks < 7);
        await assert.rejects(byteWindow.runtime.rollback({operationId: `bytes-${run}`, ancestor: genesis, maxBlocks: 1}),
            errorCode('projection.rollback-unavailable'));
        await assert.rejects(byteWindow.runtime.open(), errorCode('projection.incomplete'));
        check('actual BSON undo byte budget prunes truthful coverage independently of the block budget', {coverage: byteRecovery.coverage});

        const oversized = await scenario('oversized-undo', {rollbackRetentionBytes: 8192, rollbackMaxBlockBytes: 4096});
        const largeOwner = 'z'.repeat(3000);
        await oversized.runtime.process(frame('common', 1, [change('large-1', largeOwner, 1), change('large-2', largeOwner, 2), change('large-3', largeOwner, 3)]));
        await assert.rejects(oversized.runtime.process(frame('orphan', 2, [change('large-1', '', 0, false),
            change('large-2', '', 0, false), change('large-3', '', 0, false)])), error => error?.retryable === true);
        await physical(oversized, checkpoint(firstBlock), sorted([record('large-1', largeOwner, 1), record('large-2', largeOwner, 2), record('large-3', largeOwner, 3)]));
        const oversizeRecovery = await oversized.runtime.recovery();
        assert.equal(oversizeRecovery.pending.block.blockNum, 2);
        await assert.rejects(oversized.runtime.open(), errorCode('projection.incomplete'));
        await assertIndependent();
        check('large delete before-images cannot exceed the per-block undo budget or advance the checkpoint',
            {checkpoint: oversizeRecovery.checkpoint, pendingBlock: oversizeRecovery.pending.block.blockNum});

        const legacyDefinition = definitionFor('legacy'), legacyBinding = bindingFor(legacyDefinition);
        const legacyAdapter = createMongoDbProjectionAdapter({...rootOptions, receiptRetention: 1});
        const legacyRuntime = await DeclarativeProjectionRuntime.create({adapter: legacyAdapter, definition: legacyDefinition, binding: legacyBinding, genesis});
        await legacyRuntime.process(first); await legacyRuntime.process(orphan2);
        const legacySelected = {binding: legacyBinding};
        const legacyRaw = await metadata(legacySelected);
        assert.ok(legacyRaw);
        const beforeMigration = await physical(legacySelected, checkpoint(orphan2.block), orphanRows2);
        const upgradedAdapter = createMongoDbRollbackAdapter({...rootOptions, receiptRetention: 1});
        const upgradedRuntime = await RecoverableProjectionRuntime.create({adapter: upgradedAdapter, definition: legacyDefinition, binding: legacyBinding, genesis});
        const migrated = await upgradedRuntime.recovery();
        assert.deepEqual(migrated.coverage.floor, checkpoint(orphan2.block));
        assert.equal(migrated.coverage.retainedBlocks, 0);
        assert.deepEqual((await upgradedRuntime.query(all)).rows, orphanRows2);
        // Reproduce the historical binary's full-checkpoint filter after it had already loaded v1.
        // This is an actual old-filter write, not a claim that the complete old binary was executed.
        const staleLegacyWrite = await client.db(databaseName).collection(`${prefix}_metadata`).findOneAndUpdate({
            _id: legacyRaw._id, initialized: true, checkpoint: legacyRaw.checkpoint,
            pending: legacyRaw.pending, gap: legacyRaw.gap,
        }, {$set: {pending: {block: orphan3.block, digest: null, reason: 'Preloaded historical v1 admission'}}},
        {returnDocument: 'after', writeConcern: {w: 'majority', j: true}});
        assert.equal(staleLegacyWrite, null, 'Historical unfenced full-checkpoint CAS must miss upgraded storage');
        await physical(legacySelected, checkpoint(orphan2.block), orphanRows2);
        assert.deepEqual((await upgradedRuntime.query(all)).rows, orphanRows2);
        await assert.rejects(legacyAdapter.open(legacyBinding));
        await assert.rejects(legacyRuntime.process(orphan3));
        await upgradedRuntime.process(orphan3); await upgradedRuntime.process(orphan4);
        const migrationRollback = {operationId: `migration-floor-${run}`, ancestor: checkpoint(orphan2.block), maxBlocks: 1};
        assert.equal((await upgradedRuntime.rollback(migrationRollback)).status, 'in-progress');
        assert.equal((await upgradedRuntime.rollback(migrationRollback)).status, 'rolled-back');
        await physical(legacySelected, checkpoint(orphan2.block), orphanRows2);
        assert.equal((await upgradedRuntime.process(orphan2)).status, 'duplicate');
        await assert.rejects(upgradedRuntime.rollback({operationId: `legacy-${run}`, ancestor: checkpoint(firstBlock), maxBlocks: 1}),
            errorCode('projection.rollback-unavailable'));
        await physical(legacySelected, checkpoint(orphan2.block), orphanRows2);
        await assertIndependent();
        check('explicit v1 migration preserves state, fences legacy access and restores floor receipts beyond the ordinary replay window',
            {beforeMigration, coverage: migrated.coverage, historicalCheckpointCasMatched: false});

        assert.equal(new Set(processes.map(item => item.pid)).size, processes.length, 'Every qualification worker must be a distinct process');
        report.status = 'passed';
        return report;
    } catch (error) {
        report.status = 'failed';
        report.failure = {message: String(error?.message ?? error), code: error?.code ?? null, stack: String(error?.stack ?? '').slice(0, 16_384)};
        Object.assign(error, {rollbackReport: report});
        throw error;
    } finally {
        process.removeListener('SIGINT', cancelChildren);
        process.removeListener('SIGTERM', cancelChildren);
        cancelChildren();
        await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve))));
        report.cleanup.children = children.size === 0;
        await client.close();
        report.cleanup.client = true;
    }
}
