/** Original reader callbacks with controlled broker transports; the original recovery exit is preserved. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {serialize} from 'node:v8';
import {installWorkerRejectionDiagnostics} from '../../scripts/qualification/worker-rejection-diagnostics.mjs';
const mode = process.argv[2], hash = value => createHash('sha256').update(value).digest('hex');
const previousDirectory = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hapi-reader-rejection-'));
const cleanup = () => {
    process.chdir(previousDirectory); assert.ok(directory.startsWith(join(tmpdir(), 'hapi-reader-rejection-')));
    rmSync(directory, {recursive: true, force: true});
};
process.once('exit', cleanup);
mkdirSync(join(directory, 'config'));
writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'reader-rejection'}, indexer: {}}));
writeFileSync(join(directory, 'config/connections.json'), '{}');
process.env.CONFIG_JSON = join(directory, 'chain.json'); process.chdir(directory);
const [{default: Reader}, {default: Pool}] = await Promise.all([
    import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/workers/ds-pool.js')]);
const rows = [], diagnostics = installWorkerRejectionDiagnostics({Pool, Reader, record: (event, value) => rows.push({event, ...value})});
let confirm, shipClosed = 0, paused = 0;
const publisher = Object.assign(new EventEmitter(), {sendToQueue(queue, content, options, callback) {
    confirm = callback; if (mode === 'send-throw') throw new Error('controlled synchronous send failure'); return true;
}});
const consumer = Object.assign(new EventEmitter(), {async assertQueue() {}});
const reader = Object.assign(Object.create(Reader.prototype), {chain: 'reader-rejection', conf: {scaling: {ds_queues: 1}},
    ch: consumer, cch: publisher, ch_ready: true, cch_ready: true, isLiveReader: true,
    publications: new Map(), stageOneDistQueue: {pause() {paused++;}, resume() {}}, blockReadingQueue: {pause() {paused++;}},
    ship: {close(force) {assert.equal(force, true); shipClosed++;}}, socketGeneration: 1, activeIngressGeneration: 1,
    coordinatorSource: {readerSessionId: 'controlled-reader-session', generation: 'controlled-generation'},
    sourceContext: {id: 'controlled-source-context', readerSessionId: 'controlled-reader-session', generation: 1, schemaJson: '{"schema":"controlled"}'},
    assignmentId: 'controlled-reader-assignment'});
await reader.assertQueues();
const headers = {block_num: 33, block_id: 'c'.repeat(64), 'hyperion-action-source-v1': 'controlled-original-ingress',
    typed: Buffer.from([0, 255]), timestamp: new Date('2026-10-22T00:00:00.000Z')};
const content = Buffer.from('controlled original reader publication');
const expected = {close: 'publisher_closed_pending', error: 'publisher_error', return: 'publication_returned',
    nack: 'confirmation_failed', 'replaced-confirm': 'confirmation_publisher_replaced', 'send-throw': 'publication_threw',
    'clean-close': 'publisher_remained_closed'}[mode];
if (mode !== 'stale-close') process.once('exit', code => {
    assert.equal(code, 1); assert.equal(shipClosed, 1); assert.ok(paused >= 2);
    const row = rows.find(value => value.event === 'reader_publisher_recovery_required');
    assert.equal(row.predicate, expected); assert.equal(row.assignmentId, reader.assignmentId);
    assert.equal(row.sourceContext.id, 'controlled-source-context');
    assert.equal(row.coordinatorSource.generation, 'controlled-generation');
    const fatal = rows.find(value => value.event === 'worker_failure_decision');
    assert.equal(fatal.boundary, 'reader-publisher-recovery');
    assert.equal(fatal.originalDecisionMatch, true);
    assert.equal(fatal.reasonStillCurrent, true);
    assert.equal(fatal.decision.id, row.failureDecisionId);
    assert.equal(row.callbackPublisherIsCurrent, mode !== 'replaced-confirm');
    assert.equal(row.originalPublications.length, mode === 'clean-close' ? 0 : 1);
    if (mode !== 'clean-close') {
        const original = row.originalPublications[0];
        assert.equal(original.payloadSha256, hash(content)); assert.equal(original.headersSha256, hash(serialize(headers)));
        assert.equal(original.sourceIngressId, headers['hyperion-action-source-v1']);
        assert.equal(original.publisherId, row.callbackPublisherId);
        assert.equal(original.confirmation, mode === 'nack' ? 'failed' : mode === 'replaced-confirm' ? 'confirmed'
            : mode === 'send-throw' ? 'send-threw-unknown' : 'unknown');
    }
    assert.equal(diagnostics.snapshot().reportFailures, 0);
    console.log(JSON.stringify({passed: true, mode, rawExit: code, predicate: row.predicate, productionQualification: false}));
});
if (mode !== 'clean-close') reader.recursiveDistribute([{num: 33, content, headers}], publisher, () => {});
if (mode === 'close' || mode === 'clean-close') publisher.emit('close');
else if (mode === 'error') publisher.emit('error', new Error('controlled broker error'));
else if (mode === 'return') publisher.emit('return', {content, properties: {headers}});
else if (mode === 'nack') confirm(new Error('controlled broker NACK'));
else if (mode === 'replaced-confirm') {reader.cch = new EventEmitter(); confirm(null);}
else if (mode === 'stale-close') {
    reader.cch = new EventEmitter(); publisher.emit('close');
    assert.equal(rows.length, 0); assert.equal(shipClosed, 0); assert.equal(reader.publisherFailure, undefined);
    clearTimeout(reader.confirmationDeadline);
    console.log(JSON.stringify({passed: true, mode, rawExit: 0, productionQualification: false}));
    process.disconnect?.();
} else assert.equal(mode, 'send-throw');
if (mode !== 'stale-close') await new Promise(resolve => setTimeout(resolve, 1500)).then(() => assert.fail('Original reader recovery did not exit'));
