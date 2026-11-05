import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {withProtocolProofTransaction, withProtocolProofRequest, protocolProofScope,
    assertProtocolProofRequestActive} from '../../build/api/helpers/protocol-proof-request.js';
import {ProtocolAbiProofUnavailableError} from '../../build/indexer/protocol/abi-proof.js';

assert.equal(process.versions.bun, undefined, 'Native Node is required');
assert([24, 26].includes(Number(process.versions.node.split('.')[0])));
const changed = () => new ProtocolAbiProofUnavailableError('authority_changed', 'controlled retired root');
const scope = {}, keys = [], grants = [];
let attempts = 0;
const value = await withProtocolProofTransaction(scope, async () => {
    attempts++; keys.push(protocolProofScope(scope));
    await withProtocolProofRequest(scope, async options => {
        assert(options.signal && options.timeoutMs > 0 && options.timeoutMs <= 1000);
        grants.push({key: protocolProofScope(scope), attempt: attempts});
    });
    if (attempts === 1) throw changed();
    return 'settled';
}, 1000);
assert.equal(value, 'settled'); assert.equal(attempts, 2); assert.notEqual(keys[0], keys[1]);
assert.equal(grants[0].key, keys[0]); assert.equal(grants[1].key, keys[1]);

// Concurrent HTTP requests cannot see each other's attempt key or cancellation.
const left = {}, right = {};
const pair = await Promise.all([left, right].map(item => withProtocolProofTransaction(item, async () => {
    const key = protocolProofScope(item);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(protocolProofScope(item), key);
    return key;
}, 1000)));
assert.notEqual(pair[0], pair[1]);

const raw = Object.assign(new EventEmitter(), {aborted: false, socket: Object.assign(new EventEmitter(), {destroyed: false})});
const request = {raw}; let release, late = false, entered;
const ready = new Promise(resolve => {entered = resolve;});
const held = new Promise(resolve => {release = resolve;});
const stopped = withProtocolProofTransaction(request, async () => withProtocolProofRequest(request, async () => {
    entered(); await held; assertProtocolProofRequestActive(request); late = true;
}), 1000);
await ready; raw.emit('aborted');
await assert.rejects(stopped, error => error.code === 'proof_cancelled');
release(); await new Promise(resolve => setImmediate(resolve));
assert.equal(late, false); assert.equal(raw.listenerCount('aborted'), 0);
assert.equal(raw.socket.listenerCount('close'), 0); assert.equal(raw.socket.listenerCount('timeout'), 0);

const timeouts = [];
let invalidAttempts = 0;
await assert.rejects(withProtocolProofTransaction({}, async () => {
    invalidAttempts++;
    throw new ProtocolAbiProofUnavailableError('invalid_proof', 'never retry invalid evidence');
}, 1000), error => error.code === 'invalid_proof');
assert.equal(invalidAttempts, 1);
const boundedScope = {};
await assert.rejects(withProtocolProofTransaction(boundedScope, async () => {
    for (let index = 0; index < 10; index++) await withProtocolProofRequest(boundedScope, async options => {
        timeouts.push(options.timeoutMs); await new Promise(resolve => setTimeout(resolve, 20));
    });
}, 65), error => error.code === 'proof_timeout');
assert(timeouts.length >= 2 && timeouts.length < 10);
assert(timeouts[1] < timeouts[0]);
console.log(JSON.stringify({passed: true, runtime: process.version, emitted: true, retries: attempts,
    independentRequests: pair.length, cancellationFencedLateWork: !late, sharedDeadline: true}));
