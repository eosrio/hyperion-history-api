import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';

// Controlled transport; actual client, supervisor, source fence, drainage and end validation.
async function exercise(kind, timing) {
  const parent = new EventEmitter(), child = new EventEmitter(), ends = [];
  const supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
  const binding = {blockNum: 1, blockId: '2'.repeat(64)};
  let bindRequest, fenced = false, rootError, afterBind = false;
  const fence = () => {if (!fenced) {fenced = true; supervisor.fenceActive();}};
  parent.id = 1; parent.isConnected = () => true;
  parent.send = (message, callback) => {
    const bindReply = bindRequest && message.requestId === bindRequest && message.result?.ok === true;
    if (bindReply && timing === 'unknown-ack') {fence(); callback?.(null); return;}
    if (bindReply && timing === 'before-ack') fence();
    const response = structuredClone(message);
    if (bindReply && timing === 'mismatched-ack') response.result.bindingSha256 = '0'.repeat(64);
    child.emit('message', response);
    if (bindReply && ['after-ack', 'mismatched-ack'].includes(timing)) fence();
    callback?.(null);
  };
  child.send = (message, callback) => {
    if (message.payload?.operation === 'bind') bindRequest = message.requestId;
    parent.emit('message', structuredClone(message)); callback?.(null);
  };
  supervisor.attach(parent, 'projection');
  const client = new WorkerAttemptClient({mode: 'managed', role: 'projection', transport: child, timeoutMs: 30, retries: 0});
  const handle = client.capture({kind, receiptId: randomUUID(), payloadSha256: '1'.repeat(64),
    headersSha256: null, consumerId: null, publisherId: null, queue: null, deliveryTag: null});
  let actual;
  try {
    try {
      await client.run(handle, async () => {
        try {await client.bindCurrent(binding); afterBind = true;}
        catch (error) {rootError = error; throw error;}
      });
    } catch (error) {actual = error;}
    if (timing === 'unfenced') {
      assert.equal(actual, undefined); assert.equal(afterBind, true);
      assert.deepEqual(client.describe(handle).binding, binding);
      assert.equal(ends.length, 1);
      assert.equal(describeWorkerAttemptEnd(supervisor, ends[0]).rootResult, 'returned');
    } else if (['before-ack', 'after-ack'].includes(timing)) {
      assert.equal(rootError?.code, 'worker_attempt_fenced');
      assert.equal(actual, rootError, 'Finalization must preserve the original fence after an acknowledged binding');
      assert.equal(afterBind, false, 'A valid ACK grants no effects after cancellation');
      assert.deepEqual(client.describe(handle).binding, binding);
      assert.equal(client.describe(handle).scope.state, 'drained');
      assert.equal(ends.length, 1);
      const end = describeWorkerAttemptEnd(supervisor, ends[0]);
      assert.equal(end.status, 'quiescent'); assert.equal(end.rootResult, 'threw');
      assert.equal(end.acknowledgementAttempted, false); assert.deepEqual(end.binding, binding);
      assert.deepEqual(end.freshWrites, []); assert.equal(end.freshWriteOverflow, false);
      const consume = kind === 'projection-frame' ? 'consumeProjectionFrameDeferral' : 'consumeProjectionInitializationRetry';
      assert.equal(client[consume](handle, rootError), true);
      assert.equal(client[consume](handle, rootError), false, 'The existing bounded decision remains one-shot');
    } else {
      assert.ok(actual); assert.ok(rootError);
      assert.equal(afterBind, false);
      assert.deepEqual(client.describe(handle).binding, {}, 'An absent or mismatched ACK confirms no local binding');
      assert.equal(ends.length, 0, 'An unknown bind must not invent a quiescent end');
      assert.equal(client.consumeProjectionFrameDeferral(handle, rootError), false);
      assert.equal(client.consumeProjectionInitializationRetry(handle, rootError), false);
    }
  } finally {client.dispose(); parent.emit('exit');}
}

test('unfenced acknowledged bindings retain ordinary successful completion', () => exercise('projection-frame', 'unfenced'));
for (const kind of ['projection-initialization', 'projection-frame'])
  for (const timing of ['before-ack', 'after-ack'])
    test(`${kind} preserves a genuine quiescent end when fenced ${timing}`, () => exercise(kind, timing));
for (const timing of ['unknown-ack', 'mismatched-ack'])
  test(`${timing} confirms no binding or retry authority`, () => exercise('projection-frame', timing));
