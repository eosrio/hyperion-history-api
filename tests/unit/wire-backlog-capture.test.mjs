/** Socket-free controls of the new observer seam, not a Wire/Mongo or timed-backlog RED. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {createWireBacklogCapture, installWireBacklogCapture, encodeWireBacklogValue, decodeWireBacklogValue,
    validateWireBacklogCapture, requireWireBacklogRestore, writeWireBacklogCapture, wireBacklogCaptureLimits}
    from '../../scripts/qualification/wire-backlog-capture.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const identity = {chain: 'hyp-p191-0123456789ab', sourceHead: 'a'.repeat(40), configurationSha256: 'b'.repeat(64),
    pid: process.pid, sourceAuthority: 'controlled helper fixture, no actual chain authority'};
const bytes = value => Buffer.from(JSON.stringify(value));
const pin = b => ({bytes: b.length, sha256: hash(b)});
function fixture({send = () => false, limits} = {}) {
    const capture = createWireBacklogCapture({enabled: true, identity, ...(limits ? {limits} : {})});
    const scope = {}, channel = {}, publisher = new EventEmitter(); let active = scope;
    const sent = [], original = function (...args) {sent.push({receiver: this, args}); return send(...args);};
    publisher.sendToQueue = original;
    class Host {
        chain = identity.chain;
        workerAttemptDeliveries = new WeakMap();
        workerAttemptClient = {authority: {epoch: 'controlled-epoch'}, describe: handle => ({attemptId: handle.id,
            descriptor: {kind: 'ds-delivery', queue: identity.chain + ':ds_pool:1'}, binding: {blockNum: 1005},
            scope: {id: 'controlled-scope', state: 'open', pendingOperations: 1}})};
        captureWorkerAttemptDelivery(message, consumer, kind) {
            this.workerAttemptDeliveries.set(message, {handle: {id: 'controlled-attempt'}, receiptId: 'controlled-receipt', consumer,
                payloadSha256: hash(message.content), headersSha256: null}); return kind;
        }
        actionPublicationOwner(message) {assert.ok(this.workerAttemptDeliveries.has(message)); return {consumer: channel, publisher, current: () => true};}
    }
    class Reader {
        backpressurePaused = true; physicalIngressGeneration = 7; socketGeneration = 7;
        sourceContext = {id: 'context', readerSessionId: 'session', generation: 7};
        withheldShipCredits = {count: 8, owner: {generation: 7, epoch: {}, session: {}}};
        flushes = 0;
        flushShipCredits() {this.flushes++; if (!this.backpressurePaused) this.withheldShipCredits = undefined; return this.flushResult;}
        onIpcMessage(message) {if (message.event === 'pause') this.backpressurePaused = true;
            if (message.event === 'resume') {this.backpressurePaused = false; this.flushShipCredits();} return this.ipcResult;}
    }
    installWireBacklogCapture({capture, WorkerHost: Host, Reader, currentScope: () => active});
    const worker = new Host(), reader = new Reader(), message = {content: Buffer.from([0, 255, 1]),
        properties: {headers: {'wire-id': {type: 'longlong', value: '18446744073709551615'}, binary: Buffer.from([255, 0])}},
        fields: {deliveryTag: 17, redelivered: true}};
    worker.captureWorkerAttemptDelivery(message, channel, 'ds-delivery');
    const owner = worker.actionPublicationOwner(message);
    return {capture, worker, reader, message, owner, sent, original, channel, scope, setScope: v => {active = v;}};
}
const fields = row => decodeWireBacklogValue(row.value);

test('disabled by default performs no prototype access or identity work', () => {
    assert.equal(createWireBacklogCapture(), undefined);
    installWireBacklogCapture({capture: undefined, get WorkerHost() {throw Error('must not inspect');}});
});
test('lossless typed header codec preserves binary, decimal strings, bigint, undefined and negative zero', () => {
    const input = {a: Buffer.from([0, 255]), b: '18446744073709551615', c: 18446744073709551615n,
        d: undefined, e: [null, false, -0], typed: {type: 'longlong', value: '18446744073709551615'}};
    const output = decodeWireBacklogValue(encodeWireBacklogValue(input));
    assert.deepEqual(output.a, input.a); assert.equal(output.b, input.b); assert.equal(output.c, input.c);
    assert.equal(output.d, undefined); assert.equal(Object.hasOwn(output, 'd'), true); assert.ok(Object.is(output.e[2], -0));
    assert.equal(output.typed.type, 'longlong'); assert.equal(output.typed.value, input.b);
});
test('original accessor/cycle/sparse/non-data values refuse without invoking the getter', () => {
    let invoked = 0; const value = {get property() {invoked++; return 1;}};
    assert.throws(() => encodeWireBacklogValue(value), /accessors/); assert.equal(invoked, 0);
    const cycle = {}; cycle.self = cycle;
    for (const invalid of [cycle, Array(2), new Date(), {s: 'x'.repeat(128 * 1024 + 1)}]) assert.throws(() => encodeWireBacklogValue(invalid));
});
test('actual installed send wrapper preserves this, every argument, callback, false buffer return and listeners', () => {
    const f = fixture(), body = Buffer.from('original'), properties = {headers: {v: 1}, persistent: true, mandatory: true, messageId: 'original-id'};
    let callbacks = 0; const callback = () => {callbacks++;};
    assert.equal(f.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', body, properties, callback), false);
    const call = f.sent[0]; assert.equal(call.receiver, f.owner.publisher);
    assert.equal(call.args[1], body); assert.equal(call.args[2], properties); assert.equal(call.args[3], callback);
    assert.equal(callbacks, 0); assert.equal(f.owner.publisher.eventNames().length, 0);
    const row = f.capture.snapshot().rows.find(r => r.kind.startsWith('publication-'));
    assert.equal(row.body.base64, body.toString('base64')); assert.equal(fields(row).confirmed, 'unknown'); assert.equal(fields(row).drained, 'unknown');
    call.args[3](); assert.equal(callbacks, 1); assert.equal(f.capture.snapshot().rows.length, 2);
});
test('the wrapper neither waits for a held callback/drain nor changes returned Promise identity', async () => {
    let resolve; const held = new Promise(yes => {resolve = yes;}); const f = fixture({send: () => held});
    const returned = f.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', Buffer.from('x'), {}, () => {});
    assert.equal(returned, held); assert.equal(f.sent.length, 1); assert.equal(f.owner.publisher.listenerCount('drain'), 0);
    resolve('original'); assert.equal(await returned, 'original');
});
test('synchronous send throw and callback error are original identities, never retried', () => {
    const error = Error('original send'); const f = fixture({send: () => {throw error;}});
    assert.throws(() => f.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', Buffer.from('x'), {}, () => {}), e => e === error);
    assert.equal(f.sent.length, 1);
    let received; const g = fixture(); const callback = e => {received = e;};
    g.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', Buffer.from('x'), {}, callback);
    g.sent[0].args[3](error); assert.equal(received, error);
});
test('retained bytes and typed properties detach before original caller mutation', () => {
    const f = fixture(), body = Buffer.from('original'), headers = {v: Buffer.from([1, 2])}, options = {headers};
    f.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', body, options, () => {});
    body.fill(9); headers.v.fill(8);
    const row = f.capture.snapshot().rows.find(r => r.kind.startsWith('publication-'));
    assert.equal(Buffer.from(row.body.base64, 'base64').toString(), 'original'); assert.deepEqual(fields(row).properties.headers.v, Buffer.from([1, 2]));
});
test('foreign scope or accessor capture failure preserves original send and marks evidence incomplete', () => {
    const f = fixture(); f.setScope({});
    f.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', Buffer.from('x'), {}, () => {});
    assert.equal(f.sent.length, 1); assert.equal(f.capture.snapshot().failures, 1);
    assert.throws(() => validateWireBacklogCapture(bytes(f.capture.snapshot()), pin(bytes(f.capture.snapshot()))), /Incomplete/);
    const g = fixture(); let reads = 0; const properties = {get headers() {reads++; return {};}};
    g.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', Buffer.from('x'), properties, () => {});
    assert.equal(reads, 0); assert.equal(g.sent.length, 1); assert.equal(g.capture.snapshot().failures, 1);
});
test('original consumer receipt retains body/properties/redelivery and observational attempt, not settlement', () => {
    const f = fixture(); const row = f.capture.snapshot().rows[0], v = fields(row);
    assert.equal(row.kind, 'original-consumer-delivery'); assert.equal(row.body.sha256, hash(f.message.content));
    assert.equal(v.fields.deliveryTag, 17); assert.equal(v.fields.redelivered, true);
    assert.equal(v.custody.attempt.attemptId, 'controlled-attempt'); assert.equal(v.acknowledgement, 'unknown');
    assert.equal(v.businessSettlement, 'unknown');
});
test('reader pause/credit/generation observations do not grant, flush, or replace original returns', () => {
    const f = fixture(), marker = Promise.resolve('same'); f.reader.flushResult = marker;
    assert.equal(f.reader.flushShipCredits(), marker); assert.equal(f.reader.flushes, 1); assert.equal(f.reader.withheldShipCredits.count, 8);
    f.reader.ipcResult = marker; assert.equal(f.reader.onIpcMessage({event: 'resume'}), marker);
    assert.equal(f.reader.flushes, 2); assert.equal(f.reader.withheldShipCredits, undefined);
    const rows = f.capture.snapshot().rows.filter(r => r.kind.startsWith('credit-'));
    assert.equal(fields(rows[0]).withheld.count, 8); assert.equal(fields(rows[0]).paused, true);
    assert.equal(fields(rows.at(-1)).paused, false); assert.equal(fields(rows.at(-1)).withheld, null);
    assert.equal(fields(rows[0]).physicalIngressGeneration, 7); assert.equal(fields(rows[0]).grantsOrAuthorityIssuedByCapture, false);
});
test('row/body budgets degrade evidence explicitly and never suppress original sends', () => {
    const f = fixture({limits: {...wireBacklogCaptureLimits, maximumRows: 1}});
    for (let i = 0; i < 3; i++) f.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', Buffer.from('x'), {}, () => {});
    assert.equal(f.sent.length, 3); assert.equal(f.capture.snapshot().rows.length, 1); assert.equal(f.capture.snapshot().omitted, 3);
    const g = fixture({limits: {...wireBacklogCaptureLimits, maximumBodyBytes: 3}});
    g.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', Buffer.from('long'), {}, () => {});
    assert.equal(g.sent.length, 1); assert.equal(g.capture.snapshot().failures, 1);
});
test('caller changes to a returned snapshot or input bounds cannot rewrite retained identity or expand the budget', () => {
    const limits = {...wireBacklogCaptureLimits, maximumRows: 1}; const f = fixture({limits});
    limits.maximumRows = 100; const snapshot = f.capture.snapshot(); snapshot.identity.chain = 'foreign'; snapshot.limits.maximumRows = 100;
    f.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', Buffer.from('x'), {}, () => {});
    assert.equal(f.capture.snapshot().identity.chain, identity.chain); assert.equal(f.capture.snapshot().limits.maximumRows, 1);
    assert.equal(f.capture.snapshot().rows.length, 1); assert.equal(f.capture.snapshot().omitted, 1);
});
test('capture integrity requires external file pin and refuses changed body, chronology and foreign route', () => {
    const f = fixture(); f.owner.publisher.sendToQueue(identity.chain + ':ds_pool:1', Buffer.from('x'), {}, () => {});
    const good = bytes(f.capture.snapshot()); assert.equal(validateWireBacklogCapture(good, pin(good)).capturedBytesIntact, true);
    assert.throws(() => validateWireBacklogCapture(good), /Externally pinned/);
    for (const mutate of [v => {v.rows[0].body.base64 = 'YQ==';}, v => {v.rows[1].sequence = 1;},
        v => {v.rows[1].value = encodeWireBacklogValue({queue: 'foreign:ds_pool:1'});}]) {
        const v = JSON.parse(good); mutate(v); const bad = bytes(v); assert.throws(() => validateWireBacklogCapture(bad, pin(bad)));
    }
});
test('captured or invented ownership/store/genesis claims can never authorize restore', () => {
    const f = fixture(), value = f.capture.snapshot(); value.ownership = {current: true}; value.stores = {atomic: true}; value.genesis = {complete: true};
    const b = bytes(value); const checked = validateWireBacklogCapture(b, pin(b));
    assert.equal(checked.restorable, false); assert.ok(checked.missing.includes('fresh-source-and-worker-ownership'));
    assert.throws(() => requireWireBacklogRestore(b, pin(b)), /restore refused/);
    value.restorable = true; const fake = bytes(value); assert.throws(() => requireWireBacklogRestore(fake, pin(fake)), /Incomplete/);
});
test('terminal file is one fresh bounded evidence artifact, not a restartable savepoint', () => {
    const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'hyperion-backlog-helper-'));
    try {
        const path = join(directory, 'capture.json'), receipt = writeWireBacklogCapture(f.capture, path), b = readFileSync(path);
        assert.equal(receipt.bytes, b.length); assert.equal(receipt.sha256, hash(b)); assert.equal(receipt.restorable, false);
        assert.equal(validateWireBacklogCapture(b, receipt).restorable, false); assert.throws(() => writeWireBacklogCapture(f.capture, path), /EEXIST/);
    } finally {assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, {recursive: true});}
});
test('escaping-heavy raw-boundary typed value round-trips through producer and pinned file validator', () => {
    const value = '\0'.repeat(wireBacklogCaptureLimits.maximumValueBytes - Buffer.byteLength('headers') - Buffer.byteLength('x'));
    const capture = createWireBacklogCapture({enabled: true, identity});
    capture.observe('escaping-heavy-headers', () => ({headers: {x: value}}));
    const snapshot = capture.snapshot(); assert.equal(snapshot.failures, 0); assert.equal(snapshot.omitted, 0); assert.equal(snapshot.rows.length, 1);
    const b = bytes(snapshot); assert.equal(validateWireBacklogCapture(b, pin(b)).capturedBytesIntact, true);
    assert.equal(fields(snapshot.rows[0]).headers.x, value);
    for (const text of ['\0'.repeat(wireBacklogCaptureLimits.maximumValueBytes), '\ud800'.repeat(Math.floor(wireBacklogCaptureLimits.maximumValueBytes / 3))])
        assert.equal(decodeWireBacklogValue(encodeWireBacklogValue(text)), text);
});
test('pinned capture validation enforces each declared reduced logical-value and body limit', () => {
    const f = fixture(), good = f.capture.snapshot();
    const incorrectlyAccepted = [];
    for (const [limit, value] of [['maximumBodyBytes', 2], ['maximumValueBytes', 1], ['maximumNodes', 1], ['maximumDepth', 1]]) {
        const modified = structuredClone(good); modified.limits[limit] = value; const b = bytes(modified);
        try {validateWireBacklogCapture(b, pin(b)); incorrectlyAccepted.push(limit);} catch {}
    }
    assert.deepEqual(incorrectlyAccepted, []);
});
