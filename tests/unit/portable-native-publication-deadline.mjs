/** Publication observations share their original phase; no source proof or grant is produced. */
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {observePortableNativePublications} from '../../scripts/qualification/portable-state-worker-native.ts';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';
assertNativeQualificationRuntime();
const chain = 'hyp-p191-123456abcdef';
const expected = {payloadSha256: 'a'.repeat(64), admissionId: 'admission', fragmentId: 'fragment', blockNum: 397};
const confirmation = {kind: 'native_boundary', event: 'admitted_broker_confirmed', pid: 41,
    queue: chain + ':index_actions:1', payloadSha256: expected.payloadSha256, canonicalPayloadSha256: expected.payloadSha256,
    mandatory: true, persistent: true, headers: {'hyperion-action-admission-v1': expected.admissionId,
        action_fragment_id: expected.fragmentId, block_num: expected.blockNum}};
const variants = ['expired-ready', 'late-ready', 'late-rejection'];
const selected = process.argv[2]; if (selected) assert.ok(variants.includes(selected));
for (const variant of selected ? [selected] : variants) {
    let reads = 0, settled = false;
    const wait = async () => assert.fail('A ready or expired observation cannot start a fresh wait');
    if (variant === 'expired-ready') {
        await assert.rejects(observePortableNativePublications({chain, expected, budget: {deadline: performance.now() - 1}, wait,
            events: async () => {reads++; return [confirmation];}}), /original native history phase deadline exceeded/);
        assert.equal(reads, 0);
    } else {
        let enter, release;
        const entered = new Promise(resolve => {enter = resolve;}), held = new Promise(resolve => {release = resolve;});
        const budget = Object.freeze({deadline: performance.now() + 100});
        const original = new Error('Original held publication read rejected');
        const work = observePortableNativePublications({chain, expected, budget, wait, events: async () => {
            reads++; enter(); await held; settled = true;
            if (variant === 'late-rejection') throw original;
            return [confirmation];
        }});
        let completed = false; work.then(() => {completed = true;}, () => {completed = true;});
        await entered; await delay(Math.max(1, budget.deadline - performance.now() + 5));
        assert.equal(completed, false, 'The original pending read must remain awaited');
        release();
        await assert.rejects(work, variant === 'late-rejection' ? error => error === original : /original native history phase deadline exceeded/);
        assert.equal(settled, true); assert.equal(reads, 1);
    }
}
console.log(JSON.stringify({passed: true, node: process.versions.node, variants: selected ? [selected] : variants,
    originalDeadline: true, pendingReadAwaited: true, proofSuccessFabricated: false, fullWorkerQualification: false}));
