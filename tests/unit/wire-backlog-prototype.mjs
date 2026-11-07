/** Actual emitted worker/proof/reader methods; controlled channels only, no engines or network. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createWireBacklogCapture, installWireBacklogCapture, decodeWireBacklogValue}
    from '../../scripts/qualification/wire-backlog-capture.mjs';
const directory = mkdtempSync(join(tmpdir(), 'hyperion-backlog-prototype-'));
const originalDirectory = process.cwd();
let worker;
try {
    const config = join(directory, 'config.json'); writeFileSync(config, JSON.stringify({settings: {chain: 'hyp-p191-0123456789ab', debug: false}, indexer: {abi_scan_mode: false}}));
    mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}'); process.chdir(directory);
    process.env.CONFIG_JSON = config;
    const [{HyperionWorker}, {default: StateReader}, {currentProofConsumerScope}] = await Promise.all([
        import('../../build/indexer/workers/hyperionWorker.js'), import('../../build/indexer/workers/state-reader.js'),
        import('../../build/indexer/protocol/proof-consumer-scope.js')]);
    const chain = 'hyp-p191-0123456789ab', sha = b => createHash('sha256').update(b).digest('hex');
    const capture = createWireBacklogCapture({enabled: true, identity: {chain, sourceHead: 'a'.repeat(40),
        configurationSha256: sha(Buffer.from('controlled prototype config')), pid: process.pid,
        sourceAuthority: 'controlled-local-only prototype; no chain or parent authority'}});
    installWireBacklogCapture({capture, WorkerHost: HyperionWorker, Reader: StateReader, currentScope: () => currentProofConsumerScope()});
    const consumer = new EventEmitter(), publisher = new EventEmitter(); let sends = 0, call, acks = 0;
    consumer.ack = () => {acks++;}; consumer.nack = () => {acks++;};
    publisher.sendToQueue = function (...args) {sends++; call = {receiver: this, args}; return false;};
    worker = Object.create(HyperionWorker.prototype);
    Object.assign(worker, {chain, ch: consumer, cch: publisher, ch_ready: true, cch_ready: true, actionAdmissionOwners: new WeakMap()});
    worker.installControlledAttemptLifecycle('ds_pool_worker');
    const message = {content: Buffer.from([0, 255, 7]), properties: {headers: {block_num: 1005, raw: Buffer.from([128, 0])}},
        fields: {deliveryTag: 9, redelivered: true}};
    worker.captureActionAdmissionDelivery(message, consumer);
    await worker.runWorkerAttemptDelivery(message, async () => {
        assert.ok(currentProofConsumerScope(true)); await worker.bindWorkerAttempt({blockNum: 1005, blockId: 'c'.repeat(64)});
        const owner = worker.actionPublicationOwner(message), body = Buffer.from('original actual publication');
        const pending = worker.publishAdmitted(owner, chain + ':ds_pool:1', body, message.properties.headers);
        assert.equal(sends, 1); assert.equal(call.receiver, publisher); assert.equal(call.args[1], body);
        assert.equal(call.args[2].persistent, true); assert.equal(call.args[2].mandatory, true);
        assert.equal(typeof call.args[3], 'function'); assert.equal(call.args[2].headers, message.properties.headers);
        let settled = false; void pending.then(() => {settled = true;});
        call.args[3](null); await nextTurn(); assert.equal(settled, false, 'actual confirm alone must not finish the original publication');
        publisher.emit('drain'); await pending; assert.equal(settled, true); assert.equal(acks, 0);
    });
    const rows = capture.snapshot().rows, decoded = rows.map(row => ({kind: row.kind, value: decodeWireBacklogValue(row.value), body: row.body}));
    const delivered = decoded.find(row => row.kind === 'original-consumer-delivery'), published = decoded.find(row => row.kind.startsWith('publication-'));
    assert.equal(delivered.body.sha256, sha(message.content)); assert.equal(delivered.value.custody.payloadSha256, sha(message.content));
    assert.equal(delivered.value.fields.redelivered, true); assert.equal(delivered.value.custody.attempt.mode, 'controlled-local-only');
    assert.equal(published.value.custody.attempt.binding.blockNum, 1005); assert.equal(published.value.custody.attempt.descriptor.kind, 'ds-delivery');
    assert.equal(published.value.custody.attempt.attemptId, delivered.value.custody.attempt.attemptId);
    assert.equal(published.value.confirmed, 'unknown'); assert.equal(published.value.drained, 'unknown');
    assert.equal(published.value.properties.messageId, call.args[2].messageId);
    worker.cch_ready = false;
    assert.throws(() => worker.actionPublicationOwner(message), /channels are unavailable/);
    worker.cch_ready = true;
    const reader = Object.create(StateReader.prototype), epoch = {}, sentCredits = [], session = {encodeRequest: value => value};
    Object.assign(reader, {conf: {settings: {protocol: {provider: 'builtin'}}}, backpressurePaused: true, finishing: false,
        publisherFailure: false, physicalIngressGeneration: 7, socketGeneration: 7, shipCreditEpoch: epoch, shipSession: session,
        ship: {connected: true, send(value) {sentCredits.push(value);}}, sourceContext: {id: 'observed-context', readerSessionId: 'observed-session', generation: 7},
        withheldShipCredits: {count: 8, owner: {generation: 7, epoch, session}}});
    assert.equal(reader.flushShipCredits(), undefined); assert.equal(sentCredits.length, 0);
    assert.equal(reader.onIpcMessage({event: 'resume'}), undefined); assert.deepEqual(sentCredits, [['get_blocks_ack_request_v0', {num_messages: 8}]]);
    assert.equal(reader.withheldShipCredits, undefined);
    reader.withheldShipCredits = {count: 8, owner: {generation: 6, epoch, session}};
    reader.flushShipCredits(); assert.equal(sentCredits.length, 1, 'old generation cannot grant new credits');
    const error = Error('original socket send'); reader.ship.send = () => {throw error;};
    reader.withheldShipCredits = {count: 1, owner: {generation: 7, epoch, session}};
    assert.throws(() => reader.flushShipCredits(), value => value === error);
    const credits = capture.snapshot().rows.filter(row => row.kind.startsWith('credit-')).map(row => decodeWireBacklogValue(row.value));
    assert.ok(credits.some(row => row.paused === true && row.withheld?.count === 8 && row.physicalIngressGeneration === 7));
    assert.ok(credits.some(row => row.paused === false && row.withheld === null));
    assert.equal(capture.snapshot().failures, 0); assert.equal(capture.snapshot().omitted, 0);
    console.log(JSON.stringify({passed: true, originalPrototypeCalls: true, originalProofContext: true,
        confirmAloneHeld: true, originalConfirmAndDrain: true, unchangedOriginalCreditFenceAndError: true,
        capturedRows: capture.snapshot().rows.length, controlledLocalOnly: true, physicalOrWireCapture: false}));
} finally {
    worker?.workerAttemptClient?.dispose(); process.chdir(originalDirectory); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, {recursive: true});
}
