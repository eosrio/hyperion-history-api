/** Real qualification receipt matcher; no native proof, plan, grant or source is fabricated. */
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {observePortableNativePublications} from '../../scripts/qualification/portable-state-worker-native.ts';

const chain = 'hyp-p191-123456abcdef';
const expected = {payloadSha256: 'a'.repeat(64), admissionId: 'admission', fragmentId: 'fragment', blockNum: 397};
const confirmation = (pid = 41) => ({kind: 'native_boundary', event: 'admitted_broker_confirmed', pid,
    queue: chain + ':index_actions:1', payloadSha256: expected.payloadSha256, canonicalPayloadSha256: expected.payloadSha256,
    mandatory: true, persistent: true, headers: {'hyperion-action-admission-v1': expected.admissionId,
        action_fragment_id: expected.fragmentId, block_num: expected.blockNum}});
let waits = 0, checks = 0;
const budget = Object.freeze({deadline: performance.now() + 5000});
const wait = async (_name, check, inherited) => {
    waits++; assert.equal(inherited, budget, 'the original phase budget must be passed unchanged');
    assert.ok(performance.now() < inherited.deadline); await check();
};
const initialSnapshot = [];
await observePortableNativePublications({chain, expected, budget, wait,
    events: async () => {checks++; return checks === 1 ? initialSnapshot : [confirmation()];}});
assert.equal(checks, 2); assert.equal(waits, 1); assert.deepEqual(initialSnapshot, []);

// Neither ready nor absent receipts can complete an expired original phase.
const expired = {deadline: performance.now() - 1};
const noWait = async () => {assert.fail('No new phase deadline may be armed');};
await assert.rejects(observePortableNativePublications({chain, expected, budget: expired, wait: noWait,
    events: async () => [confirmation()]}), /original native history phase deadline exceeded/);
await assert.rejects(observePortableNativePublications({chain, expected, wait: noWait,
    events: async () => []}), /exact expected confirmed publications/);
await assert.rejects(observePortableNativePublications({chain, expected, budget: expired, wait: noWait,
    events: async () => []}), /original native history phase deadline exceeded/);
for (const mutate of [row => {row.queue = 'other:index_actions:1';}, row => {row.event = 'other';},
    row => {row.kind = 'other';}, row => {row.payloadSha256 = 'b'.repeat(64);},
    row => {row.canonicalPayloadSha256 = 'b'.repeat(64);}, row => {row.headers['hyperion-action-admission-v1'] = 'foreign';},
    row => {row.headers.action_fragment_id = 'foreign';}, row => {row.headers.block_num++;},
    row => {row.mandatory = false;}, row => {row.persistent = false;}]) {
    const changed = confirmation(); mutate(changed);
    await assert.rejects(observePortableNativePublications({chain, expected, wait: noWait, events: async () => [changed]}));
}
await assert.rejects(observePortableNativePublications({chain, expected, wait: noWait,
    events: async () => [confirmation(), confirmation()]}));
const recovered = {...expected, owners: [41, 43]};
await observePortableNativePublications({chain, expected: recovered, wait: noWait, events: async () => [confirmation(43), confirmation(41)]});
for (const owners of [[41], [41, 41], [41, 43, 47]]) await assert.rejects(observePortableNativePublications({chain,
    expected: recovered, wait: noWait, events: async () => owners.map(confirmation)}));
const failure = new Error('Original observation reader failed');
await assert.rejects(observePortableNativePublications({chain, expected, wait: noWait,
    events: async () => {throw failure;}}), error => error === failure);
let boundedChecks = 0;
const bounded = Object.freeze({deadline: performance.now() + 30});
await assert.rejects(observePortableNativePublications({chain, expected, budget: bounded,
    events: async () => {boundedChecks++; return [];}, wait: async (_name, check, inherited) => {
        assert.equal(inherited, bounded); let last;
        while (performance.now() < inherited.deadline) {try {await check(); return inherited;} catch (error) {last = error;} await delay(2);}
        throw last;
    }}), error => {
        if (!(error instanceof assert.AssertionError)) return false;
        if (error.message === 'original native history phase deadline exceeded') {
            assert.ok(Math.floor(bounded.deadline - performance.now()) <= 0,
                'deadline rejection requires the original phase to have no whole milliseconds left');
            return true;
        }
        return error.message.split('\n')[0] === 'stored output lacks its exact expected confirmed publications'
            && error.actual === 0 && error.expected === 1 && error.operator === 'strictEqual';
    });
assert.ok(boundedChecks >= 2);
// A handover reader must keep filtering old physical-generation receipts on every fresh read.
const old = confirmation(), current = confirmation(43);
let resumedChecks = 0;
await observePortableNativePublications({chain, expected, budget, wait,
    events: async () => (++resumedChecks === 1 ? [old] : [old, current]).filter(row => row.pid === 43)});
assert.equal(resumedChecks, 2);
console.log(JSON.stringify({passed: true, node: process.versions.node, freshReads: checks, inheritedDeadline: true,
    strictPublicationControls: true, proofSuccessFabricated: false, fullWorkerQualification: false}));
