import {describe, expect, it} from 'bun:test';
import {createHash} from 'node:crypto';
import {
    actionHistoryFragmentId, actionHistoryImmutableJson, actionHistoryManifestBounds, actionHistoryManifestId,
    actionHistoryPlanId, ActionHistoryManifestError, assembleActionHistoryManifest, createActionHistoryFragment,
    fingerprintActionHistoryEffect, validateActionHistoryBlockPlan, validateActionHistoryFragment, validateActionHistoryManifest,
    type ActionHistoryBlockPlan
} from '../../src/indexer/history/action-history-manifest.js';
import {boundedCanonicalJson} from '../../src/indexer/helpers/bounded-json.js';
import {protocolImmutableJson} from '../../src/indexer/protocol/immutable-bundle-store.js';

const hex = (character: string) => character.repeat(64);
const txA = hex('a'), txB = hex('b'), txC = hex('c');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const plan = (): ActionHistoryBlockPlan => ({schemaVersion: 1,
    source: {chainId: hex('1'), blockNum: 42, blockId: hex('2'), previousBlockId: hex('3'), captureSha256: hex('4')},
    producer: {protocolId: '@eosrio/wire', profileId: 'wire-sysio-v0', codeRevision: '5'.repeat(40),
        configurationSha256: hex('6'), pluginsSha256: hex('7')},
    target: {name: 'fixture-action-v3-000001', uuid: 'BGE2ohU1QYqnX8msQNjucw'},
    transactions: [
        {transactionId: txA, traceOrdinal: 0, traceSha256: hex('8'), disposition: 'process'},
        {transactionId: txB, traceOrdinal: 1, traceSha256: hex('9'), disposition: 'excluded'},
        {transactionId: txC, traceOrdinal: 2, traceSha256: hex('0'), disposition: 'no-effects'}
    ]});

const action = (sequence = '9007199254740993'): any => ({global_sequence: sequence, block_num: 42, trx_id: txA,
    code_sequence: 0xffffffff, abi_sequence: 1, action_ordinal: 7, creator_action_ordinal: 0,
    act: {account: 'contract.a', name: 'transfer', data: {global_sequence: '0042', ratio: 1.25, exponent: 1e100,
        unsafeOpaqueInteger: 9007199254740992, tiny: Number.MIN_VALUE}},
    '@plugin': {sequence: 'not-metadata'},
    receipts: [
        {receiver: 'notification', global_sequence: '18446744073709551615', recv_sequence: '9223372036854775808',
            code_sequence: 0xffffffff, abi_sequence: 0, auth_sequence: [{account: 'alice', sequence: '18446744073709551615'}]},
        {receiver: 'contract.a', global_sequence: sequence, recv_sequence: '0', auth_sequence: []}
    ]});

const complete = (source = plan()) => [
    createActionHistoryFragment(source, txA, [fingerprintActionHistoryEffect(action())]),
    createActionHistoryFragment(source, txB, []),
    createActionHistoryFragment(source, txC, [])
];

describe('immutable action history source membership', () => {
    it('binds an optional retained source identity without changing legacy plan identities', () => {
        const legacy = plan(), before = actionHistoryImmutableJson(legacy);
        const scoped = {...legacy, source: {...legacy.source, retainedSourceId: 'h45actionsource1:' + hex('a')}};
        const other = {...scoped, source: {...scoped.source, retainedSourceId: 'h45actionsource1:' + hex('b')}};
        expect(actionHistoryPlanId(scoped)).not.toBe(actionHistoryPlanId(other));
        expect(() => validateActionHistoryFragment(complete(scoped)[0], other)).toThrow('fragment binding');
        expect(actionHistoryImmutableJson(validateActionHistoryBlockPlan(legacy))).toBe(before);
        expect(actionHistoryPlanId(legacy)).toBe('h45actionplan1:' + hash(actionHistoryImmutableJson(['hyperion-action-history-plan-v1', legacy])));
        for (const invalid of [null, '', 'h45actionsource1:' + hex('A'), 'h45actionsource2:' + hex('a'), hex('a')]) {
            const value: any = structuredClone(scoped); value.source.retainedSourceId = invalid;
            expect(() => validateActionHistoryBlockPlan(value)).toThrow('Invalid action history source block plan');
        }
    });
    it('returns separate frozen source plans and deterministic domain-specific identities', () => {
        const input = plan(), before = structuredClone(input), validated = validateActionHistoryBlockPlan(input);
        expect(validated).toEqual(input); expect(validated).not.toBe(input);
        expect(Object.isFrozen(validated)).toBe(true); expect(Object.isFrozen(validated.source)).toBe(true);
        expect(Object.isFrozen(validated.transactions)).toBe(true); expect(Object.isFrozen(validated.transactions[0])).toBe(true);
        expect(actionHistoryPlanId(input)).toBe('h45actionplan1:' + hash(actionHistoryImmutableJson(['hyperion-action-history-plan-v1', input])));
        const reorderedKeys = {transactions: input.transactions, target: input.target, producer: input.producer,
            source: input.source, schemaVersion: 1} as ActionHistoryBlockPlan;
        expect(actionHistoryPlanId(reorderedKeys)).toBe(actionHistoryPlanId(input));
        expect(validateActionHistoryBlockPlan(validated)).toBe(validated); // Known immutable plans can be reused by every transaction.
        expect(input).toEqual(before);
        expect(() => {(validated.source as any).blockNum = 99;}).toThrow();
        (input.source as any).blockNum = 99; expect(validated.source.blockNum).toBe(42);
    });

    it.each([
        ['source.chainId', (value: any) => {value.source.chainId = hex('e');}],
        ['source.blockNum', (value: any) => {value.source.blockNum++;}],
        ['source.blockId', (value: any) => {value.source.blockId = hex('e');}],
        ['source.previousBlockId', (value: any) => {value.source.previousBlockId = hex('e');}],
        ['source.captureSha256', (value: any) => {value.source.captureSha256 = hex('e');}],
        ['producer.protocolId', (value: any) => {value.producer.protocolId = 'antelope';}],
        ['producer.profileId', (value: any) => {value.producer.profileId = 'wire-engineering-v1';}],
        ['producer.codeRevision', (value: any) => {value.producer.codeRevision = 'e'.repeat(40);}],
        ['producer.configurationSha256', (value: any) => {value.producer.configurationSha256 = hex('e');}],
        ['producer.pluginsSha256', (value: any) => {value.producer.pluginsSha256 = hex('e');}],
        ['target.name', (value: any) => {value.target.name = 'other-action-v3-000001';}],
        ['target.uuid', (value: any) => {value.target.uuid = 'recreated-index';}],
        ['transaction.traceSha256', (value: any) => {value.transactions[0].traceSha256 = hex('e');}],
        ['transaction.disposition', (value: any) => {value.transactions[0].disposition = 'excluded';}],
        ['transaction.traceOrdinal', (value: any) => {value.transactions[2].traceOrdinal = 4;}]
    ])('binds %s into the plan and every fragment', (_, mutate) => {
        const original = plan(), changed = structuredClone(original); mutate(changed);
        expect(actionHistoryPlanId(changed)).not.toBe(actionHistoryPlanId(original));
        expect(() => validateActionHistoryFragment(complete(original)[0], changed)).toThrow('fragment binding');
    });

    it.each([
        (value: any) => {value.schemaVersion = 2;},
        (value: any) => {value.extra = true;},
        (value: any) => {delete value.source.captureSha256;},
        (value: any) => {value.source.previousBlockId = null;},
        (value: any) => {value.source.blockNum = 0;},
        (value: any) => {value.source.blockNum = 0x100000000;},
        (value: any) => {value.source.blockNum = '42';},
        (value: any) => {value.source.chainId = 'A'.repeat(64);},
        (value: any) => {value.producer.codeRevision = '5'.repeat(39);},
        (value: any) => {value.producer.codeRevision = 'G'.repeat(40);},
        (value: any) => {value.producer.pluginsSha256 = '';},
        (value: any) => {value.producer.profileId = 'missing\nprofile';},
        (value: any) => {value.target.name = 'fixture-*';},
        (value: any) => {value.target.uuid = '';},
        (value: any) => {value.transactions[0].transactionId = 'a'.repeat(63);},
        (value: any) => {value.transactions[1].transactionId = txA;},
        (value: any) => {value.transactions[1].traceOrdinal = 0;},
        (value: any) => {value.transactions[0].traceOrdinal = 0.5;},
        (value: any) => {value.transactions[2].traceOrdinal = 0x100000000;},
        (value: any) => {value.transactions.reverse();},
        (value: any) => {value.transactions[0].disposition = 'unknown';},
        (value: any) => {value.transactions[0].traceSha256 = hex('g');},
        (value: any) => {value.transactions[0].extra = true;}
    ])('rejects malformed, incomplete or ambiguous source plans', mutate => {
        const input = plan(); mutate(input);
        expect(() => validateActionHistoryBlockPlan(input)).toThrow(ActionHistoryManifestError);
        expect(() => actionHistoryPlanId(input)).toThrow(ActionHistoryManifestError);
    });

    it('accepts the full numeric uint32 trace ordinal without retyping counters', () => {
        const input = plan(); (input.transactions[2] as any).traceOrdinal = 0xffffffff;
        expect(validateActionHistoryBlockPlan(input).transactions[2].traceOrdinal).toBe(0xffffffff);
    });

    it('assembles all explicit members in original source order regardless of worker arrival order', () => {
        const source = plan(), fragments = complete(source), before = structuredClone(fragments);
        const manifest = assembleActionHistoryManifest(source, [fragments[2], fragments[0], fragments[1]]);
        expect(manifest.fragments.map(fragment => fragment.transactionId)).toEqual([txA, txB, txC]);
        expect(manifest.fragments.map(fragment => fragment.effects.length)).toEqual([1, 0, 0]);
        expect(validateActionHistoryManifest(manifest, source)).toEqual(manifest);
        expect(actionHistoryManifestId(manifest, source)).toBe('h45actionmanifest1:' +
            hash(actionHistoryImmutableJson(['hyperion-action-history-manifest-v1', manifest])));
        expect(actionHistoryFragmentId(fragments[0], source)).toBe('h45actionfragment1:' +
            hash(actionHistoryImmutableJson(['hyperion-action-history-fragment-v1', fragments[0]])));
        expect(Object.isFrozen(manifest)).toBe(true); expect(Object.isFrozen(manifest.fragments)).toBe(true);
        expect(Object.isFrozen(manifest.fragments[0].effects[0])).toBe(true);
        expect(fragments).toEqual(before);
        expect(() => validateActionHistoryManifest({...manifest, fragments: [...manifest.fragments].reverse()}, source)).toThrow('source transaction order');
    });

    it('cannot infer a complete block from surviving or successfully written outputs', () => {
        const source = plan(), fragments = complete(source);
        expect(() => assembleActionHistoryManifest(source, fragments.slice(0, 1))).toThrow('Incomplete');
        expect(() => assembleActionHistoryManifest(source, fragments.slice(0, 2))).toThrow('Incomplete');
        expect(() => assembleActionHistoryManifest(source, [...fragments, fragments[0]])).toThrow('Incomplete');
        expect(() => assembleActionHistoryManifest(source, [fragments[0], fragments[0], fragments[2]])).toThrow('Repeated');
        const foreign = {...fragments[1], transactionId: hex('d')};
        expect(() => assembleActionHistoryManifest(source, [fragments[0], foreign, fragments[2]])).toThrow('Unplanned');
    });

    it.each([
        (value: any) => {value.schemaVersion = 2;},
        (value: any) => {value.transactionId = hex('d');},
        (value: any) => {value.extra = true;},
        (value: any) => {delete value.effects;},
        (value: any) => {value.effects = null;},
        (value: any) => {value.effects[0].documentSha256 = hex('g');},
        (value: any) => {value.effects[0].metadataSha256 = hex('A');},
        (value: any) => {value.effects[0].extra = true;}
    ])('validates raw fragment envelopes and digests independently of the factory', mutate => {
        const source = plan(), fragment = structuredClone(complete(source)[0]); mutate(fragment);
        expect(() => validateActionHistoryFragment(fragment, source)).toThrow(ActionHistoryManifestError);
        expect(() => actionHistoryFragmentId(fragment, source)).toThrow(ActionHistoryManifestError);
    });

    it('validates raw manifest envelopes and refuses a foreign source plan', () => {
        const source = plan(), manifest = assembleActionHistoryManifest(source, complete(source));
        for (const value of [{...manifest, schemaVersion: 2}, {...manifest, extra: true}, {...manifest, fragments: null},
            {...manifest, planId: 'h45actionplan1:' + hex('f')}]) {
            expect(() => validateActionHistoryManifest(value, source)).toThrow(ActionHistoryManifestError);
        }
        const foreign = structuredClone(source); (foreign.source as any).captureSha256 = hex('f');
        expect(() => validateActionHistoryManifest(manifest, foreign)).toThrow('manifest binding');
    });

    it('requires an explicit zero-effect fragment for each excluded or effect-free transaction', () => {
        const source = plan(), effect = fingerprintActionHistoryEffect(action());
        for (const transactionId of [txB, txC]) {
            const fragment = createActionHistoryFragment(source, transactionId, []);
            expect(fragment.effects).toEqual([]);
            expect(() => createActionHistoryFragment(source, transactionId, [effect])).toThrow('contains action effects');
        }
        const empty = plan(); (empty as any).transactions = [];
        const manifest = assembleActionHistoryManifest(empty, []);
        expect(manifest).toEqual({schemaVersion: 1, planId: actionHistoryPlanId(empty), fragments: []});
        expect(validateActionHistoryManifest(manifest, empty)).toEqual(manifest);
        expect(() => assembleActionHistoryManifest(empty, [createActionHistoryFragment(source, txB, [])])).toThrow('Incomplete');
    });

    it('keeps effect source order and rejects duplicate canonical action IDs inside or across transactions', () => {
        const source = plan(), later = fingerprintActionHistoryEffect(action('18446744073709551615')),
            earlier = fingerprintActionHistoryEffect(action('9223372036854775808'));
        const fragment = createActionHistoryFragment(source, txA, [later, earlier]);
        expect(fragment.effects.map(effect => effect.globalSequence)).toEqual([later.globalSequence, earlier.globalSequence]);
        expect(() => createActionHistoryFragment(source, txA, [later, later])).toThrow('repeated');
        const both = structuredClone(source); (both.transactions[1] as any).disposition = 'process';
        const fragments = [createActionHistoryFragment(both, txA, [later]), createActionHistoryFragment(both, txB, [later]),
            createActionHistoryFragment(both, txC, [])];
        expect(() => assembleActionHistoryManifest(both, fragments)).toThrow('across transactions');
        const changedDocument = {...earlier, documentSha256: hex('f')};
        expect(actionHistoryFragmentId(createActionHistoryFragment(source, txA, [changedDocument]), source)).not.toBe(
            actionHistoryFragmentId(createActionHistoryFragment(source, txA, [earlier]), source));
    });

    it.each(['0', '01', '+1', ' 1', '1e3', '18446744073709551616', 42, 9007199254740992])('rejects noncanonical effect ID %s', sequence => {
        const effect = {...fingerprintActionHistoryEffect(action()), globalSequence: sequence};
        expect(() => createActionHistoryFragment(plan(), txA, [effect as any])).toThrow(ActionHistoryManifestError);
    });

    it('bounds source membership and rejects nonportable data before invoking any accessor', () => {
        const tooMany = plan(); (tooMany as any).transactions = Array(actionHistoryManifestBounds.maximumTransactions + 1).fill(null);
        expect(() => validateActionHistoryBlockPlan(tooMany)).toThrow('block plan');
        const tooManyEffects = Array(actionHistoryManifestBounds.maximumEffects + 1).fill(null);
        expect(() => createActionHistoryFragment(plan(), txA, tooManyEffects)).toThrow('effect list');
        let reads = 0; const input = plan(); Object.defineProperty(input, 'source', {get() {reads++; throw new Error('getter ran');}, enumerable: true});
        expect(() => validateActionHistoryBlockPlan(input)).toThrow('accessors'); expect(reads).toBe(0);
        const fragment = structuredClone(complete()[0]); Object.defineProperty(fragment, 'injected', {get() {reads++; return true;}, enumerable: true});
        expect(() => validateActionHistoryFragment(fragment, plan())).toThrow('accessors'); expect(reads).toBe(0);
    });

    it('checks declared collection counts before visiting their children', () => {
        let reads = 0;
        const overflow: any[] = Array(actionHistoryManifestBounds.maximumTransactions + 1);
        Object.defineProperty(overflow, '0', {get() {reads++; throw new Error('oversize child visited');}, enumerable: true});
        expect(() => validateActionHistoryBlockPlan({...plan(), transactions: overflow})).toThrow('bounded transaction count');
        expect(() => createActionHistoryFragment(plan(), txA, overflow)).toThrow('bounded count');
        const source = plan(), manifest: any = {schemaVersion: 1, planId: actionHistoryPlanId(source), fragments: overflow};
        expect(() => validateActionHistoryManifest(manifest, source)).toThrow('bounded transaction count');
        const fragments: any[] = [{schemaVersion: 1, planId: manifest.planId, transactionId: txA, effects: overflow},
            complete(source)[1], complete(source)[2]];
        expect(() => assembleActionHistoryManifest(source, fragments)).toThrow('bounded effect count');
        expect(reads).toBe(0);
    });
});

describe('exact action history effect fingerprints', () => {
    it.each(['1', '9007199254740991', '9007199254740992', '9007199254740993',
        '9223372036854775807', '9223372036854775808', '18446744073709551615'])('fingerprints exact grouped metadata for %s while preserving opaque finite data', sequence => {
        const logical = action(sequence), before = structuredClone(logical), effect = fingerprintActionHistoryEffect(logical);
        expect(effect.globalSequence).toBe(sequence);
        expect(effect.documentSha256).toBe(hash(actionHistoryImmutableJson(logical)));
        expect(effect.metadataSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(logical).toEqual(before);
        expect(logical.code_sequence).toBe(0xffffffff); expect(typeof logical.code_sequence).toBe('number');
        const changedData = structuredClone(logical); changedData.act.data.ratio = 1.5;
        const changed = fingerprintActionHistoryEffect(changedData);
        expect(changed.documentSha256).not.toBe(effect.documentSha256);
        expect(changed.metadataSha256).toBe(effect.metadataSha256);
        const changedMetadata = structuredClone(logical); changedMetadata.receipts[0].auth_sequence[0].sequence = '0';
        expect(fingerprintActionHistoryEffect(changedMetadata).metadataSha256).not.toBe(effect.metadataSha256);
    });

    it('preserves prototype-looking opaque keys, association and repeated references as ordinary JSON', () => {
        const logical = action(); logical.act.data = JSON.parse('{"__proto__":{"ratio":1.25},"constructor":{"name":"data"},"toString":"literal"}');
        const before = actionHistoryImmutableJson(logical), effect = fingerprintActionHistoryEffect(logical);
        expect(effect.documentSha256).toBe(hash(before)); expect(before).toContain('"__proto__":{"ratio":1.25}');
        expect(Object.hasOwn(logical.act.data, '__proto__')).toBe(true);
        const reversed = structuredClone(logical); reversed.receipts.reverse();
        expect(fingerprintActionHistoryEffect(reversed).metadataSha256).not.toBe(effect.metadataSha256);
        expect(fingerprintActionHistoryEffect(reversed).globalSequence).toBe(logical.global_sequence);
        const shared = {ratio: 1.25}; logical.act.data = {a: shared, b: shared};
        expect(() => fingerprintActionHistoryEffect(logical)).not.toThrow();
    });

    it.each([
        (value: any) => {delete value.global_sequence;},
        (value: any) => {value.global_sequence = 9007199254740992;},
        (value: any) => {value.global_sequence = 42;},
        (value: any) => {value.receipts[0].recv_sequence = '00';},
        (value: any) => {value.receipts[1].auth_sequence = null;},
        (value: any) => {value.code_sequence = '4294967295';},
        (value: any) => {value.abi_sequence = 0x100000000;},
        (value: any) => {value.act.data = NaN;},
        (value: any) => {value.act.data = Infinity;},
        (value: any) => {value.act.data = 1n;},
        (value: any) => {value.act.data = undefined;},
        (value: any) => {value.act.data = new Date();},
        (value: any) => {value.act.data = Buffer.from('opaque');},
        (value: any) => {value.act.data = [1, , 2];},
        (value: any) => {value.act.data = value;},
        (value: any) => {value.act.data = '\ud800';}
    ])('refuses malformed exact metadata or nonportable data without manufacturing a digest', mutate => {
        const logical = action(); mutate(logical);
        expect(() => fingerprintActionHistoryEffect(logical)).toThrow(ActionHistoryManifestError);
    });

    it('checks all descriptors before the codec can clone or invoke custom serialization', () => {
        for (const inject of [
            (value: any, read: () => never) => Object.defineProperty(value.act, 'data', {get: read, enumerable: true}),
            (value: any, read: () => never) => {value.act.data.toJSON = read;},
            (value: any, read: () => never) => Object.defineProperty(value, 'hidden', {get: read, enumerable: false})
        ]) {
            let reads = 0; const logical = action(); inject(logical, () => {reads++; throw new Error('getter ran');});
            expect(() => fingerprintActionHistoryEffect(logical)).toThrow(ActionHistoryManifestError); expect(reads).toBe(0);
        }
    });
});

describe('bounded canonical JSON policies', () => {
    it.each(['4294967295', '4294967296', '18446744073709551615'])(
        'rejects a sparse array whose ignored numeric property %s could masquerade as a member', property => {
            const sparse = new Array(1);
            Object.defineProperty(sparse, property, {value: 'not an array member', enumerable: true});
            expect(JSON.stringify(sparse)).toBe('[null]');
            expect(() => protocolImmutableJson(sparse)).toThrow('ABI observation contains accessors or sparse data');
            expect(() => actionHistoryImmutableJson(sparse)).toThrow('sparse data');
            const logical = action(); logical.act.data = sparse;
            expect(() => fingerprintActionHistoryEffect(logical)).toThrow(ActionHistoryManifestError);
        });

    it('preserves the existing protocol canonical bytes and exact error text while action data permits finite fractions', () => {
        const input = JSON.parse('{"z":[null,true,false,0,-1,9007199254740991],"é":"a\\n\\t\\u0000\\\"\\\\😀","a":{"__proto__":"plain"}}');
        const expected = '{"a":{"__proto__":"plain"},"z":[null,true,false,0,-1,9007199254740991],"é":"a\\n\\t\\u0000\\\"\\\\😀"}';
        expect(protocolImmutableJson(input)).toBe(expected); expect(actionHistoryImmutableJson(input)).toBe(expected);
        expect(protocolImmutableJson(input, Buffer.byteLength(expected))).toBe(expected);
        expect(() => protocolImmutableJson(input, Buffer.byteLength(expected) - 1)).toThrow('ABI observation exceeds bounded JSON byte budget');
        expect(() => protocolImmutableJson(1.25)).toThrow('ABI observation is not portable JSON');
        expect(() => protocolImmutableJson(9007199254740992)).toThrow('ABI observation is not portable JSON');
        expect(() => protocolImmutableJson('\ud800')).toThrow('ABI observation contains malformed UTF-16');
        expect(() => protocolImmutableJson(new Date())).toThrow('ABI observation contains a native value');
        expect(() => protocolImmutableJson([,])).toThrow('ABI observation contains accessors or sparse data');
        expect(actionHistoryImmutableJson({fraction: 1.25, unsafeOpaqueInteger: 9007199254740992})).toBe('{"fraction":1.25,"unsafeOpaqueInteger":9007199254740992}');
    });

    it('enforces escaped UTF-8 byte budgets, depth and portable object structure in both policies', () => {
        for (const value of ['é', '😀', '\u0001', '\b\t\n\f\r', '\\"']) {
            const encoded = JSON.stringify(value), bytes = Buffer.byteLength(encoded);
            expect(actionHistoryImmutableJson(value, bytes)).toBe(encoded);
            expect(() => actionHistoryImmutableJson(value, bytes - 1)).toThrow('byte budget');
        }
        let depth: any = null; for (let index = 0; index < 65; index++) depth = [depth];
        expect(() => actionHistoryImmutableJson(depth)).toThrow('node/depth budget');
        expect(() => protocolImmutableJson(depth)).toThrow('ABI observation exceeds bounded JSON node/depth budget');
        const cycle: any = {}; cycle.self = cycle;
        expect(() => protocolImmutableJson(cycle)).toThrow('ABI observation is not portable JSON');
        const inherited = Object.create({hidden: 'prototype'}); inherited.visible = true;
        expect(() => actionHistoryImmutableJson(inherited)).toThrow('native value');
        const symbols = {[Symbol('hidden')]: true};
        expect(() => actionHistoryImmutableJson(symbols)).toThrow('native value');
        const extra: any = []; extra.nonIndex = 'ignored by ordinary JSON.stringify';
        expect(() => actionHistoryImmutableJson(extra)).toThrow('sparse data');
        expect(boundedCanonicalJson(Object.assign(Object.create(null), {z: 1, a: 2}))).toBe('{"a":2,"z":1}');
        expect(() => actionHistoryImmutableJson(Array(1_000_000).fill(null))).toThrow('node/depth budget');
        for (const invalid of [NaN, Infinity, 0, -1, 0.5, actionHistoryManifestBounds.maximumBytes + 1]) {
            expect(() => actionHistoryImmutableJson({}, invalid)).toThrow('Invalid action history JSON byte budget');
        }
    });
});
