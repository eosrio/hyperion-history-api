import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WorkerProofDemandObserver} from '../../build/indexer/history/action-proof-demand-enrollment.js';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';

assertNativeQualificationRuntime();
let hooks = 0;
const redirected = new Uint8Array(128 * 1024).fill(0xee);
const ordinary = Buffer.from([0x99, 0x11, 0x22, 0x88]).subarray(1, 3);
const ownConversion = Buffer.from([0x99, 0x11, 0x22, 0x88]).subarray(1, 3);
Object.defineProperty(ownConversion, 'valueOf', {get() {
    hooks++; return () => {hooks++; return redirected;};
}});
class ConvertedView extends Uint8Array {
    valueOf() {hooks++; return redirected;}
}
class LayoutView extends Uint8Array {
    get length() {hooks++; throw new Error('Ordinary length accessor must not execute');}
}
const cases = [['ordinary-offset-buffer', ordinary], ['own-conversion-buffer', ownConversion],
    ['inherited-conversion-view', new ConvertedView(new Uint8Array([0x11, 0x22]))],
    ['inherited-layout-view', new LayoutView(new Uint8Array([0x11, 0x22]))]];
const results = [];
for (const [name, payload] of cases) {
    const packets = [];
    const observer = new WorkerProofDemandObserver((packet, done) => {packets.push(packet); done();});
    observer.capture(randomUUID(), payload, {block_num: 33});
    assert.equal(hooks, 0, `${name}: conversion/layout hooks ran before the bound`);
    assert.equal(packets.length, 1, `${name}: original view was not captured`);
    assert.equal(JSON.parse(packets[0]).payloadHex, '1122', `${name}: bytes escaped the original view`);
    assert.equal(Buffer.byteLength(packets[0]) < 16 * 1024, true);
    assert.equal(observer.snapshot().knownCapturedPayloadBytes, 2);
    assert.equal(observer.snapshot().failures, 0);
    results.push(name);
}
process.stdout.write(JSON.stringify({passed: true, native: process.version, cases: results, hooks,
    originalPayloadBytes: 2, redirectedBytesNeverCopied: redirected.byteLength, fullWorkerQualification: false}) + '\n');
