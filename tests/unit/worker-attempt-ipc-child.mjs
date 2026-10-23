/** Owned native child for the private worker-lifecycle IPC qualification. */
import cluster from 'node:cluster';
import {randomUUID, createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import assert from 'node:assert/strict';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';

const gate = () => {let release; const promise = new Promise(resolve => {release = resolve;}); return {promise, release};};
const body = gate(), finalizer = gate();
const interval = setInterval(() => {}, 1000);
const role = process.env.QUALIFICATION_WORKER_ROLE ?? 'ds_pool_worker';
const client = new WorkerAttemptClient({mode: 'managed', role, transport: process,
    timeoutMs: 150, drainTimeoutMs: 500, retries: 2});
const report = (phase, data = {}) => process.send?.({event: 'qualification_phase', phase, data});
let handle, work, actualWorker, actualReceipt, originalConsumer, directory, retainedHelper;

async function captureActualRole(headerKind) {
    directory = mkdtempSync(join(tmpdir(), 'hyperion-attempt-owned-ipc-'));
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {}}));
    const configuration = {settings: {chain: 'owned-ipc-role'}, indexer: {}, features: {}, whitelists: {}, blacklists: {}};
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(configuration));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    const {default: Actual} = await import(role === 'deserializer' ? '../../build/indexer/workers/deserializer.js' : '../../build/indexer/workers/ds-pool.js');
    originalConsumer = new EventEmitter(); originalConsumer.acked = [];
    originalConsumer.ack = message => {assert.equal(message, actualReceipt); originalConsumer.acked.push(message); report('role-ack-attempted');};
    actualWorker = Object.create(Actual.prototype);
    Object.assign(actualWorker, {ch: originalConsumer, cch: new EventEmitter(), ch_ready: true, cch_ready: true,
        profiler: {start: () => () => {}}, protocol: {profileId: 'controlled-parser-entry-only'},
        chain: 'owned-ipc-role', conf: configuration, client: frontierMemoryClient().client,
        actionAdmissionOwners: new WeakMap(), protocolDeliveryOwners: new WeakMap(), poolAbiCache: new Map(), poolTypeCache: new Map(),
        protocolCacheViews: new Set(),
        mLoader: {parser: {async parseMessage(worker, messages) {
            assert.equal(messages.length, 1); assert.equal(messages[0], actualReceipt);
            report('role-parser-entered');
            try {await body.promise; worker.settleOriginalWorkerDelivery(actualReceipt);}
            finally {report('role-finalizer-entered'); await finalizer.promise; report('role-finalizer-ended');}
        }}}});
    actualWorker.configureWorkerAttemptLifecycle(client);
    actualReceipt = {content: Buffer.from('original-physical-source-custody'),
        properties: {headers: {binary: Buffer.from('00ff', 'hex'), timestamp: new Date('2026-10-22T00:00:00Z')}}, fields: {deliveryTag: 42}};
    if (role === 'ds_pool_worker') actualReceipt.properties.headers = {block_num: 1};
    if (headerKind === 'oversized') actualReceipt.properties.headers = {oversized: Buffer.alloc(65 * 1024, 1)};
    if (headerKind === 'unsupported') actualReceipt.properties.headers = {unsupported: () => {}};
    if (role === 'deserializer') actualWorker.captureWorkerAttemptDelivery(actualReceipt, originalConsumer, 'source-delivery');
    else {
        Object.defineProperty(actualWorker, 'actionSourceAdmissionEnabled', {value: true});
        actualWorker.captureActionAdmissionDelivery(actualReceipt, originalConsumer); actualWorker.captureProtocolActionDelivery(actualReceipt, originalConsumer);
    }
    report('role-captured', {role, deliveryTag: 42, parserCalls: 0});
}

async function command(message) {
    if (message.command === 'start') {
        const digest = bytes => createHash('sha256').update(bytes).digest('hex');
        handle = client.capture({kind: 'ds-delivery', receiptId: randomUUID(), payloadSha256: digest('original-cargo'),
            headersSha256: digest('{}'), consumerId: randomUUID(), publisherId: randomUUID(), queue: 'owned:ds', deliveryTag: 1});
        report('captured', client.describe(handle));
        work = client.run(handle, async () => {
            retainedHelper = currentProofConsumerScope(true).bindCallback(() => report('late-host-helper-invoked'));
            report('body-entered'); await body.promise;
            client.markAcknowledgementAttempt(); report('ack-attempted');
            await finalizer.promise; report('finalizer-ended'); return 'original-result';
        });
        void work.then(result => report('done', {result, attempt: client.describe(handle)}),
            error => report('failed', {message: error.message, attempt: client.describe(handle)}));
    } else if (message.command === 'probe-helper') {
        try {retainedHelper(); report('probe-returned');}
        catch (error) {report('probe-rejected', {code: error.code, attempt: client.describe(handle)});}
    } else if (message.command === 'new-root') {
        try {
            const next = client.capture({...client.describe(handle).descriptor, receiptId: randomUUID()});
            await client.run(next, () => report('new-root-entered')); report('new-root-returned');
        } catch (error) {report('new-root-rejected', {message: error.message});}
    } else if (message.command === 'capture-role') await captureActualRole(message.headerKind);
    else if (message.command === 'run-role') {
        work = actualWorker.processMessages([actualReceipt]);
        void work.then(() => report('role-done', {acks: originalConsumer.acked.length}),
            error => report('role-failed', {message: error.message, code: error.code, acks: originalConsumer.acked.length}));
    } else if (message.command === 'mutate-role') {
        actualReceipt.content[0] ^= 1; report('role-mutated');
    } else if (message.command === 'close-role') {
        originalConsumer.emit('close'); report('role-original-channel-closed');
    } else if (message.command === 'finish-body') body.release();
    else if (message.command === 'finish-finalizer') finalizer.release();
    else if (message.command === 'repeat') {
        try {await client.run(handle, () => report('repeated-body')); report('repeat-returned');}
        catch (error) {report('repeat-rejected', {message: error.message});}
    }
    else if (message.command === 'replay') process.send?.(message.request);
    else if (message.command === 'disconnect') {
        cluster.worker.disconnect();
        setTimeout(() => process.stdout.write('OWNED_PROCESS_ALIVE_AFTER_IPC_DISCONNECT\n'), 50);
    } else if (message.command === 'quit') {
        client.dispose(); clearInterval(interval);
        if (directory) {
            const owned = resolve(directory); assert.equal(dirname(owned), resolve(tmpdir()));
            assert.match(basename(owned), /^hyperion-attempt-owned-ipc-/);
            process.chdir(tmpdir()); rmSync(owned, {recursive: true, force: true});
        }
        process.exit(0);
    }
}
process.on('message', message => {
    if (message?.event === 'qualification_command') void command(message).catch(error => report('command-failed', {message: error.message}));
});
report('ready', {native: process.version});
