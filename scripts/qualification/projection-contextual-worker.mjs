import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MongoClient} from 'mongodb';
import {
    canonicalContextualProjectionBatch, validateContextualProjectionDefinition,
    validateContextualProjectionBinding, validateContextualProjectionRecoveryApplyInput, validateContextualProjectionApply,
} from '@eosrio/hyperion-sdk/projection';
import {boundedCanonicalJson} from '../../build/indexer/helpers/bounded-json.js';
import {createMongoDbContextualRecoveryAdapter} from '../../packages/backend-mongodb/dist/index.js';
import {assertNativeQualificationRuntime} from './native-node-runtime.mjs';

export function validateContextualWorkerJob(input) {
    const job = JSON.parse(boundedCanonicalJson(input, {maximumBytes: 128 * 1024,
        numberPolicy: 'safe-integer', errorPrefix: 'Contextual fixture job'}));
    assert.deepEqual(Object.keys(job).sort(), ['backendId', 'binding', 'collectionPrefix', 'databaseName', 'definition', 'request', 'run', 'schemaVersion', 'uri']);
    assert.equal(job.schemaVersion, 1); assert.match(job.run, /^[0-9a-f]{32}$/);
    assert.equal(job.databaseName, `hyp_context_${job.run}`);
    assert.equal(job.backendId, `fixture-contextual-${job.run}`); assert.equal(job.collectionPrefix, 'h45_contextual');
    const endpoint = new URL(job.uri);
    assert.equal(endpoint.protocol, 'mongodb:'); assert.equal(endpoint.hostname, '127.0.0.1');
    assert.equal(endpoint.username, ''); assert.equal(endpoint.password, ''); assert.equal(endpoint.pathname, '/');
    assert.equal(endpoint.hash, ''); assert.deepEqual([...endpoint.searchParams], [['directConnection', 'true']]);
    assert.ok(/^\d+$/.test(endpoint.port) && Number(endpoint.port) > 1024 && Number(endpoint.port) < 65536 && Number(endpoint.port) !== 27017);
    assert.equal(validateContextualProjectionDefinition(job.definition).valid, true);
    assert.equal(validateContextualProjectionBinding(job.definition, job.binding).valid, true);
    assert.equal(job.binding.backendId, job.backendId);
    const captured = validateContextualProjectionRecoveryApplyInput(job.request); assert.equal(captured.valid, true);
    assert.equal(validateContextualProjectionApply(job.definition, captured.value.batch).valid, true);
    assert.deepEqual(JSON.parse(JSON.stringify(captured.value.batch.binding)), job.binding);
    return job;
}

/** Deliberate native-process loss only after the original driver's actual durable intent response. */
async function main() {
    assertNativeQualificationRuntime();
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) {
        bytes += chunk.length; assert.ok(bytes <= 128 * 1024, 'Contextual job exceeds stdin bound'); chunks.push(chunk);
    }
    const job = validateContextualWorkerJob(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const digest = createHash('sha256').update(canonicalContextualProjectionBatch(job.request.batch)).digest('hex');
    const client = new MongoClient(job.uri, {appName: `h45-contextual-crash-${job.run}`, directConnection: true,
        retryWrites: false, monitorCommands: true, serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500, timeoutMS: 5000});
    let intentRequest;
    client.on('commandStarted', event => {
        if (event.databaseName !== job.databaseName || event.commandName !== 'findAndModify'
            || event.command.findAndModify !== `${job.collectionPrefix}_metadata`) return;
        const pending = event.command.update?.$set?.pending;
        if (pending?.digest !== digest) return;
        assert.deepEqual(pending.block, job.request.batch.block);
        assert.equal(event.command.writeConcern.w, 'majority'); assert.equal(event.command.writeConcern.j, true);
        assert.equal(event.command.txnNumber, undefined); intentRequest = event.requestId;
    });
    client.on('commandSucceeded', event => {
        if (event.commandName !== 'findAndModify' || event.requestId !== intentRequest) return;
        const stored = event.reply.value;
        assert.equal(stored.storageVersion, 'h45-contextual-mongodb-recovery-v1');
        assert.deepEqual(stored.binding, job.binding); assert.equal(stored.revision, job.request.revision);
        assert.deepEqual(stored.pending.block, job.request.batch.block); assert.equal(stored.pending.digest, digest);
        assert.equal(stored.checkpoint.blockNum, job.request.batch.previous.blockNum);
        assert.equal(stored.checkpoint.blockId, job.request.batch.previous.blockId);
        writeSync(1, JSON.stringify({boundary: 'durable-contextual-intent-before-transaction', pid: process.pid,
            revision: job.request.revision, block: job.request.batch.block, digest}) + '\n');
        process.exit(86);
    });
    try {
        await client.connect();
        const adapter = createMongoDbContextualRecoveryAdapter({client, databaseName: job.databaseName,
            backendId: job.backendId, collectionPrefix: job.collectionPrefix});
        await adapter.apply(job.request);
        throw new Error('Contextual worker did not reach the exact acknowledged crash boundary');
    } finally {await client.close();}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {writeSync(2, JSON.stringify({error: String(error.message).slice(0, 4096), code: error.code ?? null}) + '\n'); process.exitCode = 1;});
}
