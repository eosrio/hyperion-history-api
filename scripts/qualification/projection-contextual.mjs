import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MongoClient} from 'mongodb';
import {canonicalContextualProjectionBatch} from '@eosrio/hyperion-sdk/projection';
import {createMongoDbContextualRecoveryAdapter} from '../../packages/backend-mongodb/dist/index.js';
import {ContextualProjectionRuntime} from '../../build/indexer/projection/contextual-runtime.js';
import {waitForMongo} from './projection-fixture.mjs';
import {assertNativeQualificationRuntime} from './native-node-runtime.mjs';
import {validateContextualWorkerJob} from './projection-contextual-worker.mjs';

const hex = number => number.toString(16).padStart(64, '0');
const genesis = {blockNum: 0, blockId: hex(0)}, all = {filter: [], limit: 10};
const errorCode = code => error => error?.code === code;
const canonical = value => value !== null && typeof value === 'object' ? Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const workerPath = fileURLToPath(new URL('./projection-contextual-worker.mjs', import.meta.url));

/** Called only by the refusal-first owned Mongo fixture. No cluster URL CLI or service activation. */
export async function runContextualProjectionQualification({uri, run, replicaSet, assertOwned, restart}) {
    assertNativeQualificationRuntime(); assert.match(run, /^[0-9a-f]{32}$/);
    assert.equal(replicaSet, `h45rs_${run}`, 'Contextual qualification requires the owned run replica-set identity');
    assert.equal(typeof assertOwned, 'function'); assert.equal(typeof restart, 'function'); assertOwned();
    const databaseName = `hyp_context_${run}`, backendId = `fixture-contextual-${run}`, collectionPrefix = 'h45_contextual';
    const definition = {schemaVersion: 2, id: 'contextual-items', mappingRevision: 'a'.repeat(64),
        source: {contract: 'token', table: 'items', abiDeployment: 'deployment-1', abiSha256: 'b'.repeat(64)},
        fields: [{name: 'contract', type: 'string', source: {kind: 'context', field: 'contract'}},
            {name: 'owner', type: 'string', source: {kind: 'row', path: ['owner']}},
            {name: 'created', type: 'string', source: {kind: 'context', field: 'blockNum', format: 'decimal'}},
            {name: 'time', type: 'string', source: {kind: 'context', field: 'blockTimeMs', format: 'decimal'}},
            {name: 'nullable', type: 'null', source: {kind: 'row', path: ['nullable']}}],
        initialization: {kind: 'genesis'}, preserveOnReplace: ['created', 'time', 'nullable'], onAbsent: 'incomplete'};
    const binding = {chainId: 'c'.repeat(64), backendId, projectionId: definition.id, mappingRevision: definition.mappingRevision,
        abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256, generation: 'fixture-instance'};
    const frame = (number, owner, time = number * 1000, id = hex(number)) => ({chainId: binding.chainId,
        block: {blockNum: number, blockId: id, previousBlockId: hex(number - 1)},
        context: {contract: 'token', table: 'items', blockTimeMs: time},
        changes: [{contract: 'token', table: 'items', scope: '', primaryKey: 'one',
            abiDeployment: binding.abiDeployment, abiSha256: binding.abiSha256, present: true,
            value: {owner, nullable: null, created: 'untrusted', time: 'untrusted'}}]});
    const expected = (owner, created = '1', time = '1000') => [{key: '["","one"]',
        value: {contract: 'token', owner, created, time, nullable: null}}];
    const report = {schemaVersion: 1, status: 'running', qualification: false, scope: 'Owned Mongo contextual transactions/restart/undo component qualification; no production canonical recovery, HTTP or parity',
        node: process.version, checks: [], commands: [], cleanup: {client: false}, restart: null};
    let client, adapter, runtime, endpoint = uri;
    const open = async () => {
        assertOwned();
        client = await waitForMongo(() => {
            const value = new MongoClient(endpoint, {appName: `h45-contextual-${run}`, directConnection: true,
                retryWrites: false, monitorCommands: true, maxPoolSize: 4, serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500, timeoutMS: 5000});
            value.on('commandStarted', event => {
                if (report.commands.length < 256 && ['findAndModify', 'update', 'insert', 'delete', 'commitTransaction', 'abortTransaction'].includes(event.commandName))
                    report.commands.push({phase: 'started', command: event.commandName, requestId: event.requestId,
                        transaction: event.command.txnNumber?.toString() ?? null});
            });
            value.on('commandFailed', event => {
                if (report.commands.length < 256) report.commands.push({phase: 'failed', command: event.commandName, code: event.failure?.code ?? null});
            });
            return value;
        }, {primary: true, replicaSet});
        adapter = createMongoDbContextualRecoveryAdapter({client, databaseName, backendId, collectionPrefix});
        runtime = await ContextualProjectionRuntime.create({adapter, definition, binding, genesis});
    };
    const check = (name, details) => report.checks.push({name, ...(details === undefined ? {} : {details})});
    const physical = async (number, rows) => {
        const metadata = await client.db(databaseName).collection(`${collectionPrefix}_metadata`).findOne({'binding.projectionId': binding.projectionId});
        assert.equal(metadata.checkpoint.blockNum, number); assert.equal(metadata.checkpoint.revision, metadata.revision);
        const documents = await client.db(databaseName).collection(`${collectionPrefix}_r_${hash(canonical(binding))}`).find({}).sort({_id: 1}).toArray();
        assert.deepEqual(documents.map(row => ({key: row._id, value: row.value})), rows);
        return metadata;
    };
    const restartOwned = async () => {
        assertOwned(); await client.close(); client = undefined;
        endpoint = await restart(); assertOwned(); report.restart = endpoint; await open();
    };
    try {
        await open();
        const initial = await runtime.open(), first = frame(1, 'alice'), second = frame(2, 'bob');
        second.changes.push({...structuredClone(second.changes[0]), value: {...second.changes[0].value, owner: 'carol'}});
        await runtime.process(first); const b = await runtime.process(second);
        assert.deepEqual((await runtime.query(all)).rows, expected('carol'));
        assert.equal((await runtime.process(second)).status, 'duplicate');
        const conflict = structuredClone(second); conflict.context.blockTimeMs = 2001;
        await assert.rejects(runtime.process(conflict), errorCode('projection.conflicting-replay'));
        await physical(2, expected('carol'));
        check('A insertion and ordered repeated-key B replacements preserve original creation/null and original replay identity');
        await restartOwned(); assert.deepEqual((await runtime.query(all)).rows, expected('carol'));
        check('actual server restart and fresh adapter/runtime retain contextual definition, revision and preserved record');

        const third = frame(3, 'dora'); assertOwned();
        await client.db('admin').command({configureFailPoint: 'failCommand', mode: {times: 1},
            data: {failCommands: ['update'], errorCode: 2, appName: `h45-contextual-${run}`}});
        try {await assert.rejects(runtime.process(third), errorCode('projection.apply-unavailable'));}
        finally {assertOwned(); await client.db('admin').command({configureFailPoint: 'failCommand', mode: 'off'});}
        const failed = await physical(2, expected('carol')); assert.equal(failed.pending.block.blockNum, 3);
        await assert.rejects(runtime.open(), errorCode('projection.incomplete'));
        await runtime.process(third); assert.deepEqual((await runtime.query(all)).rows, expected('dora'));
        check('failed native transactional update leaves B effects/checkpoint and exact pending C; original retry preserves creation');

        const state = await runtime.recovery(), fourth = frame(4, 'emma');
        const request = {revision: state.revision, batch: {binding, previous: state.checkpoint, block: fourth.block,
            source: fourth.context, policy: {preserveOnReplace: definition.preserveOnReplace, onAbsent: definition.onAbsent},
            mutations: [{kind: 'put-preserving', key: '["","one"]', value: {contract: 'token', owner: 'emma', created: '4', time: '4000', nullable: null},
                preserveFields: definition.preserveOnReplace}]}};
        const job = validateContextualWorkerJob({schemaVersion: 1, run, uri: endpoint, databaseName, backendId, collectionPrefix,
            definition, binding, request}); assertOwned();
        const child = spawnSync(process.execPath, [workerPath], {input: JSON.stringify(job), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
        assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 86, child.stderr);
        const boundary = JSON.parse(child.stdout); assert.equal(boundary.pid, child.pid);
        assert.equal(boundary.boundary, 'durable-contextual-intent-before-transaction');
        assert.equal(boundary.digest, hash(canonicalContextualProjectionBatch(request.batch))); report.unknownIntent = boundary;
        const pending = await physical(3, expected('dora')); assert.equal(pending.pending.digest, boundary.digest);
        await assert.rejects(adapter.open(binding), errorCode('projection.incomplete'));
        await restartOwned();
        await assert.rejects(runtime.open(), errorCode('projection.incomplete'));
        const repaired = await adapter.apply(request); assert.equal(repaired.status, 'applied');
        runtime = await ContextualProjectionRuntime.create({adapter, definition, binding, genesis});
        assert.deepEqual((await runtime.query(all)).rows, expected('emma'));
        assert.equal((await adapter.apply(request)).status, 'duplicate');
        check('actual process exit after durable original intent plus server restart resumes the exact full contextual candidate/digest');

        const end = await runtime.recovery(), undoUpdates = {binding, revision: end.revision, operationId: `updates-${run}`,
            from: end.checkpoint, ancestor: {blockNum: 1, blockId: hex(1)}, maxBlocks: 1};
        for (const [number, owner] of [[3, 'dora'], [2, 'carol'], [1, 'alice']]) {
            const step = await runtime.rollback(undoUpdates); assert.equal(step.status, number === 1 ? 'rolled-back' : 'in-progress');
            await physical(number, expected(owner));
        }
        const a = await runtime.open(); assert.deepEqual((await runtime.query(all)).rows, expected('alice'));
        const undoA = {binding, revision: a.revision, operationId: `insert-${run}`, from: a.checkpoint, ancestor: genesis, maxBlocks: 1};
        await runtime.rollback(undoA); const empty = await runtime.open(); await physical(0, []);
        await assert.rejects(adapter.query(initial, all), errorCode('projection.stale-revision'));
        const c = frame(1, 'faye', 3000, hex(100)); const appliedC = await runtime.process(c);
        assert.deepEqual((await runtime.query(all)).rows, expected('faye', '1', '3000'));
        assert.equal((await runtime.rollback(undoA)).status, 'duplicate');
        assert.deepEqual((await runtime.query(all)).rows, expected('faye', '1', '3000'));
        await assert.rejects(adapter.apply({...request, revision: b.view.revision}), errorCode('projection.stale-revision'));
        await assert.rejects(adapter.query(b.view, all), errorCode('projection.stale-revision'));
        const retained = await adapter.retainedCheckpoints({binding, revision: appliedC.view.revision});
        assert.deepEqual(JSON.parse(JSON.stringify(retained.checkpoints)), [{blockNum: 1, blockId: hex(100)}, genesis]);
        check('bounded undo restores every pre-block image, removes A, inserts replacement C with new context and fences ABA/old operations', {revision: empty.revision});
        const absent = frame(2, 'absent', 4000); absent.block.previousBlockId = c.block.blockId;
        absent.changes[0].present = false; delete absent.changes[0].value;
        await assert.rejects(runtime.process(absent), errorCode('projection.incomplete'));
        await assert.rejects(runtime.open(), errorCode('projection.incomplete'));
        await physical(1, expected('faye', '1', '3000'));
        const otherDefinition = {...definition, id: 'unrelated-context'}, otherBinding = {...binding, projectionId: otherDefinition.id};
        const other = await ContextualProjectionRuntime.create({adapter, definition: otherDefinition, binding: otherBinding, genesis});
        await other.process(frame(1, 'healthy'));
        assert.deepEqual((await other.query(all)).rows, expected('healthy'));
        const restored = frame(2, 'repaired', 4000); restored.block.previousBlockId = c.block.blockId;
        await runtime.process(restored); assert.deepEqual((await runtime.query(all)).rows, expected('repaired', '1', '3000'));
        check('declared absence leaves only its projection incomplete; unrelated indexing/queries continue and exact source repair preserves C creation');
        report.status = 'passed'; return report;
    } catch (error) {report.status = 'failed'; report.failure = {message: String(error.message), code: error.code ?? null}; error.contextualReport = report; throw error;}
    finally {if (client) await client.close(); report.cleanup.client = true;}
}
