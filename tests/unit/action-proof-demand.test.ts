import {expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {serialize} from 'node:v8';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd, type AcceptedWorkerAttemptEnd} from '../../src/indexer/protocol/worker-attempt-supervisor.js';
import {WorkerAttemptClient} from '../../src/indexer/protocol/worker-attempt-client.js';
import {ActionAttemptAdjudicator, type ActionAttemptAdjudicatorOptions} from '../../src/indexer/history/action-attempt-adjudicator.js';
import {issueFreshActionWrite} from '../../src/indexer/history/action-fresh-write.js';
import {actionHistoryImmutableJson} from '../../src/indexer/history/action-history-manifest.js';
import {ImmutableProtocolBundleStore} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import * as demand from '../../src/indexer/history/action-proof-demand.js';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

async function fixture(onVerifiedDsTransition: (value: any) => void,
                       configure: (options: ActionAttemptAdjudicatorOptions) => void = () => {},
                       disposition: 'no-effects' | 'contract-output-incomplete' = 'no-effects') {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: value => ends.push(value)});
    const physical = new EventEmitter() as any, transport = new EventEmitter() as any;
    physical.isConnected = () => true;
    physical.send = (message: any, callback?: (error: Error | null) => void) => {transport.emit('message', structuredClone(message)); callback?.(null);};
    transport.send = (message: any, callback?: (error: Error | null) => void) => {physical.emit('message', structuredClone(message)); callback?.(null);};
    supervisor.attach(physical, 'ds_pool_worker');
    const client = new WorkerAttemptClient({mode: 'managed', role: 'ds_pool_worker', transport, timeoutMs: 100, retries: 0});
    const chainId = 'c'.repeat(64), blockId = 'b'.repeat(64), previousBlockId = 'a'.repeat(64), config = 'd'.repeat(64);
    const source = {chainId, blockNum: 33, blockId, previousBlockId};
    const payload = Buffer.from('{"id":"original-dispatch"}'), headers = {block_num: 33, action_trace_ordinal: 0};
    const admissionId = 'h45actionadmission1:' + 'a'.repeat(64), sourceId = 'h45actionsource1:' + '1'.repeat(64),
        planId = 'h45actionplan1:' + '2'.repeat(64), ingressId = 'h45actioningress1:' + '3'.repeat(64),
        dispositionId = 'h45actionattempt1:' + '4'.repeat(64), target = {name: 'fixture-action-v1-000001', uuid: 'target-uuid'};
    const producer = {protocolId: 'antelope', profileId: 'antelope-default-v1', codeRevision: '0'.repeat(40),
        configurationSha256: config, pluginsSha256: '8'.repeat(64)};
    const transaction = {transactionId: 'e'.repeat(64), traceOrdinal: 0, traceSha256: 'f'.repeat(64),
        dispatch: {canonicalJson: payload.toString(), bodySha256: hash(payload)}, groups: disposition === 'no-effects' ? [] : [{}]};
    const work = {stage: 'ds-transaction', admissionId, sourceId, ingressId, planId, target, producer,
        executableSha256: '6'.repeat(64), policySha256: '7'.repeat(64), sourceSelectionId: null,
        transaction: {transactionId: transaction.transactionId, traceOrdinal: 0, traceSha256: transaction.traceSha256,
            dispatchSha256: hash(payload), expectedGroups: transaction.groups.length}, source: {...source, captureSha256: '5'.repeat(64)}};
    const observation = {kind: 'action-attempt-disposition', disposition, work};
    const admission: any = {id: admissionId, sourceId, planId, target,
        inventory: {sourceSelectionId: null, policySha256: work.policySha256, transactions: [transaction]},
        source: {ingressId, frameHex: '00', previousBlockId, captureSha256: work.source.captureSha256,
            executableSha256: work.executableSha256, producer,
            inventoryInput: {source: {...source, producer: 'original-producer', timestamp: '2026-10-26T18:42:43.000'}, policy: {}}}};
    let current = true, storageUnavailable = false;
    const store: any = {resolve: async () => admission,
        readAttemptDisposition: async () => ({id: dispositionId, observation}),
        recordAttemptAssociation: async () => {if (storageUnavailable) throw new Error('controlled lost association'); return {id: 'private-association'};}};
    const authority = {configurationSha256: () => config, targetUuid: async () => target.uuid,
        canonicalBlock: async () => ({...source, irreversible: true}),
        assertCanonicalCurrent: () => {if (!current) throw new Error('controlled canonical revocation');}};
    const options = {onVerifiedDsTransition}; configure(options);
    const adjudicator = new ActionAttemptAdjudicator(supervisor, store, {} as any, authority, options);
    const bundles = new ImmutableProtocolBundleStore(frontierMemoryClient().client as any, 'shadow-demand-fixture', 0,
        'action-source-admission', 'history-source-admission-v1');
    const handle = client.capture({kind: 'ds-delivery', receiptId: randomUUID(), payloadSha256: hash(payload),
        headersSha256: hash(serialize(headers)), consumerId: randomUUID(), publisherId: randomUUID(), queue: 'fixture:ds', deliveryTag: 1});
    await client.run(handle, async () => {
        await client.bindCurrent({admissionId, planId, traceOrdinal: 0, blockNum: source.blockNum, blockId,
            configurationSha256: config, targetName: target.name, targetUuid: target.uuid});
        const prepared = await bundles.prepare(dispositionId, {schemaVersion: 1, payloadJson: actionHistoryImmutableJson(observation)});
        const fresh = issueFreshActionWrite({id: dispositionId}, 'attempt-disposition', dispositionId, observation, prepared, bundles);
        expect(await client.observeFreshActionWrite(fresh)).toBe(true);
        client.markAcknowledgementAttempt();
    });
    return {adjudicator, end: ends[0], owner: describeWorkerAttemptEnd(supervisor, ends[0]), payload, headers,
        source, admissionId, setCurrent(value: boolean) {current = value;},
        setStorageUnavailable(value: boolean) {storageUnavailable = value;}, close() {client.dispose();}};
}

test('the original verified DS association emits one transition without changing its result', async () => {
    const observed: unknown[] = [], value = await fixture(token => {observed.push(token);});
    try {
        expect(observed).toHaveLength(0);
        expect(await value.adjudicator.adjudicate(value.end)).toEqual({state: 'associated', id: 'private-association'});
        expect(observed).toHaveLength(1);
        expect(await value.adjudicator.adjudicate(value.end)).toEqual({state: 'associated', id: 'private-association'});
        expect(observed).toHaveLength(1);
    } finally {value.close();}
});

test('observer failure after token consumption rejects provisional accounting without changing the association', async () => {
    const finalized: boolean[] = [];
    let value: Awaited<ReturnType<typeof fixture>>;
    value = await fixture(token => {
        value.adjudicator.consumeVerifiedDsTransition(token, accepted => {finalized.push(accepted);});
        throw new Error('controlled observer failure after consumption');
    });
    try {
        expect(await value.adjudicator.adjudicate(value.end)).toEqual({state: 'associated', id: 'private-association'});
        expect(finalized).toEqual([false]);
        expect(value.adjudicator.transitionSnapshot()).toMatchObject({failures: 1, incomplete: true});
    } finally {value.close();}
});

test('a captured dispatch stays charged until its own verified DS transition completes', async () => {
    let shadow: demand.ActionProofDemandShadow;
    const value = await fixture(token => {shadow.observe(token);});
    try {
        shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 4, maximumBytes: 1024});
        const retained = shadow.retain({owner: value.owner, source: {...value.source, selectionId: null},
            admissionId: value.admissionId, traceOrdinal: 0, payload: value.payload, headers: value.headers, stage: 'ds-input'});
        expect(retained).toBeDefined();
        const before = shadow.snapshot();
        expect(before).toMatchObject({pendingDemands: 1, resolvedDemands: 0, accounting: 'complete', unknownPendingHeaders: 0});
        expect(before.demands[0]).toMatchObject({payloadBytes: 26, state: 'pending'});
        expect(before.knownPendingBytes).toBeGreaterThan(26);
        expect(await value.adjudicator.adjudicate(value.end)).toEqual({state: 'associated', id: 'private-association'});
        expect(shadow.snapshot()).toMatchObject({pendingDemands: 0, resolvedDemands: 1, knownPendingBytes: 0,
            accounting: 'complete', observationOnly: true, demands: [{state: 'resolved', classifications: ['intentional-no-effect']}]});
    } finally {value.close();}
});

test('a source fence during the observer leaves the captured charge unresolved', async () => {
    let shadow: demand.ActionProofDemandShadow, value: Awaited<ReturnType<typeof fixture>>;
    value = await fixture(token => {shadow.observe(token); value.setCurrent(false);});
    try {
        shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 4, maximumBytes: 1024});
        shadow.retain({owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: value.headers, stage: 'ds-input'});
        const before = shadow.snapshot().knownPendingBytes;
        expect(await value.adjudicator.adjudicate(value.end)).toEqual({state: 'associated', id: 'private-association'});
        expect(shadow.snapshot()).toMatchObject({accounting: 'incomplete', pendingDemands: 1, resolvedDemands: 0, knownPendingBytes: before});
    } finally {value.close();}
});

test('unavailable observer lookup cannot replace the original durable association', async () => {
    const value = await fixture(() => {}, options => Object.defineProperty(options, 'onVerifiedDsTransition', {
        get() {throw new Error('controlled observer lookup failure');},
    }));
    try {
        expect(await value.adjudicator.adjudicate(value.end)).toEqual({state: 'associated', id: 'private-association'});
        expect(value.adjudicator.transitionSnapshot()).toMatchObject({failures: 1, incomplete: true});
    } finally {value.close();}
});

test('unsafe captured headers remain unknown and charged without invoking accessors', async () => {
    const value = await fixture(() => {}); let reads = 0;
    const headers = Object.defineProperty({}, 'accessor', {enumerable: true, get() {reads++; return 'unavailable';}});
    try {
        const shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 4, maximumBytes: 1024});
        shadow.retain({owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers, stage: 'ds-input'});
        expect(reads).toBe(0);
        expect(shadow.snapshot()).toMatchObject({accounting: 'incomplete', pendingDemands: 1, knownPendingBytes: 26,
            unknownPendingHeaders: 1, demands: [{headersBytes: null, headersSha256: null}]});
    } finally {value.close();}
});

test('metadata exhaustion records omitted charge without growing or evicting the retained window', async () => {
    const value = await fixture(() => {});
    try {
        const shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 1, maximumBytes: 1024});
        const input = {owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: value.headers, stage: 'ds-input' as const};
        shadow.retain(input);
        expect(shadow.retain({...input, owner: {...value.owner, attemptId: randomUUID()}})).toBeUndefined();
        expect(shadow.snapshot()).toMatchObject({accounting: 'incomplete', retainedDemands: 1, pendingDemands: 1,
            omittedDemands: 1, omittedKnownBytesLowerBound: 26, unknownOmittedHeaderCopies: 1});
    } finally {value.close();}
});

test('tokens reject copied, foreign, repeated and later consumption', async () => {
    let token: any, description: demand.VerifiedActionDsTransitionDescription | undefined;
    let foreignRejected = false, copyRejected = false, repeatRejected = false;
    const foreign = await fixture(() => {});
    let value: Awaited<ReturnType<typeof fixture>>;
    value = await fixture(original => {
        token = original;
        try {foreign.adjudicator.consumeVerifiedDsTransition(original);} catch {foreignRejected = true;}
        try {value.adjudicator.consumeVerifiedDsTransition(JSON.parse(JSON.stringify(original)));} catch {copyRejected = true;}
        description = value.adjudicator.consumeVerifiedDsTransition(original);
        try {value.adjudicator.consumeVerifiedDsTransition(original);} catch {repeatRejected = true;}
    });
    try {
        await value.adjudicator.adjudicate(value.end);
        expect([foreignRejected, copyRejected, repeatRejected]).toEqual([true, true, true]);
        expect(description).toMatchObject({stage: 'ds-input', brokerSettlement: 'unknown', observationOnly: true,
            payloadBytes: 26, results: [{classification: 'intentional-no-effect'}]});
        expect(() => value.adjudicator.consumeVerifiedDsTransition(token)).toThrow('expired');
        expect(() => value.adjudicator.consumeVerifiedDsTransition({...token})).toThrow('Unissued');
    } finally {value.close(); foreign.close();}
});

test('unknown headers and other retained copies remain charged after a DS-stage observation', async () => {
    let shadow: demand.ActionProofDemandShadow;
    const value = await fixture(token => {shadow.observe(token);});
    try {
        shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 4, maximumBytes: 1024});
        const input = {owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload};
        shadow.retain({...input, stage: 'ds-input'});
        shadow.retain({...input, stage: 'retained-copy', copyId: 'queued-output'});
        await value.adjudicator.adjudicate(value.end);
        expect(shadow.snapshot()).toMatchObject({accounting: 'incomplete', pendingDemands: 2, resolvedDemands: 0,
            knownPendingBytes: 52, unknownPendingHeaders: 2, unavailableTransitions: 1,
            stages: {'ds-input': {pendingDemands: 1}, 'retained-copy': {pendingDemands: 1}}});
    } finally {value.close();}
});

test('an incomplete contract disposition verifies its stage without fabricating recovery or completion', async () => {
    let shadow: demand.ActionProofDemandShadow;
    const value = await fixture(token => {shadow.observe(token);}, undefined, 'contract-output-incomplete');
    try {
        shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 4, maximumBytes: 1024});
        shadow.retain({owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: value.headers, stage: 'ds-input'});
        const charged = shadow.snapshot().knownPendingBytes;
        await value.adjudicator.adjudicate(value.end);
        expect(shadow.snapshot()).toMatchObject({pendingDemands: 1, resolvedDemands: 0, knownPendingBytes: charged,
            accounting: 'incomplete', unavailableTransitions: 1, demands: [{state: 'uncertain', classifications: ['contract-incomplete']}]});
    } finally {value.close();}
});

test('lost association persistence and observer failure retain the original input charge', async () => {
    let shadow: demand.ActionProofDemandShadow;
    const value = await fixture(token => {shadow.observe(token); throw new Error('controlled observer failure');});
    try {
        shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 4, maximumBytes: 1024});
        shadow.retain({owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: value.headers, stage: 'ds-input'});
        const charged = shadow.snapshot().knownPendingBytes;
        value.setStorageUnavailable(true);
        await expect(value.adjudicator.adjudicate(value.end)).rejects.toThrow('controlled lost association');
        expect(value.adjudicator.transitionSnapshot().emitted).toBe(0);
        expect(shadow.snapshot()).toMatchObject({pendingDemands: 1, knownPendingBytes: charged});
        value.setStorageUnavailable(false);
        expect(await value.adjudicator.adjudicate(value.end)).toEqual({state: 'associated', id: 'private-association'});
        expect(shadow.snapshot()).toMatchObject({pendingDemands: 1, resolvedDemands: 0, knownPendingBytes: charged, accounting: 'incomplete'});
    } finally {value.close();}
});

test('unsafe and oversized headers never erase the known payload charge', async () => {
    const value = await fixture(() => {}), cyclic: any = {}; cyclic.self = cyclic;
    try {
        for (const headers of [cyclic, {text: 'x'.repeat(65537)}, {unsupported() {}}, new Array(1000000)]) {
            const shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 1, maximumBytes: 1024});
            shadow.retain({owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
                traceOrdinal: 0, payload: value.payload, headers, stage: 'ds-input'});
            expect(shadow.snapshot()).toMatchObject({pendingDemands: 1, knownPendingBytes: 26,
                unknownPendingHeaders: 1, accounting: 'incomplete'});
        }
        const shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 1, maximumBytes: 16});
        expect(shadow.retain({owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: value.headers, stage: 'ds-input'})).toBeUndefined();
        expect(shadow.snapshot()).toMatchObject({retainedDemands: 0, omittedDemands: 1, omittedKnownBytesLowerBound: 26,
            unknownOmittedHeaderCopies: 1, accounting: 'incomplete'});
    } finally {value.close();}
});

test('different selections, physical attempts and sparse heights stay separate', async () => {
    let shadow: demand.ActionProofDemandShadow;
    const value = await fixture(token => {shadow.observe(token);});
    try {
        shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 8, maximumBytes: 1024});
        const input = {owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: value.headers, stage: 'ds-input' as const};
        shadow.retain(input);
        shadow.retain({...input, source: {...input.source, selectionId: 'h45srcsel1:' + '1'.repeat(64)}});
        shadow.retain({...input, source: {...input.source, blockNum: 289, blockId: '9'.repeat(64)}});
        shadow.retain({...input, owner: {...input.owner, attemptId: randomUUID(), incarnation: randomUUID()}});
        expect(shadow.retain(input)).toBeUndefined();
        expect(shadow.snapshot()).toMatchObject({retainedDemands: 4, pendingDemands: 4, rejectedRetains: 1});
        await value.adjudicator.adjudicate(value.end);
        const observed = shadow.snapshot();
        expect(observed).toMatchObject({pendingDemands: 3, resolvedDemands: 1});
        expect(observed.demands.filter(value => value.state === 'pending').map(value => [value.source.blockNum, value.source.selectionId])).toEqual([
            [33, 'h45srcsel1:' + '1'.repeat(64)], [289, null], [33, null],
        ]);
        observed.demands[1].source.blockNum = 1;
        expect(shadow.snapshot().demands[1].source.blockNum).toBe(33);
    } finally {value.close();}
});

test('a duplicate retained identity is not counted as new omitted work when the window is full', async () => {
    const value = await fixture(() => {});
    try {
        const shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 1, maximumBytes: 1024});
        const input = {owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: value.headers, stage: 'ds-input' as const};
        shadow.retain(input); const bytes = shadow.snapshot().knownPendingBytes;
        expect(shadow.retain(input)).toBeUndefined();
        expect(shadow.snapshot()).toMatchObject({retainedDemands: 1, pendingDemands: 1, knownPendingBytes: bytes,
            rejectedRetains: 1, omittedDemands: 0, omittedKnownBytesLowerBound: 0});
    } finally {value.close();}
});

test('bigint headers beyond the finite 64-bit shadow range stay unknown before encoding', async () => {
    const value = await fixture(() => {});
    try {
        const shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 1, maximumBytes: 131072});
        shadow.retain({owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: {oversized: 1n << 65536n}, stage: 'ds-input'});
        expect(shadow.snapshot()).toMatchObject({pendingDemands: 1, knownPendingBytes: 26,
            unknownPendingHeaders: 1, accounting: 'incomplete'});
    } finally {value.close();}
});

test('overridden typed-array length accessors are not invoked by shadow capture', async () => {
    const value = await fixture(() => {}); let reads = 0;
    const binary = Object.defineProperty(new Uint8Array(8), 'byteLength', {get() {reads++; throw new Error('unavailable accessor');}});
    try {
        const shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 1, maximumBytes: 1024});
        shadow.retain({owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: {binary}, stage: 'ds-input'});
        expect(reads).toBe(0);
        expect(shadow.snapshot()).toMatchObject({pendingDemands: 1, knownPendingBytes: 26,
            unknownPendingHeaders: 1, accounting: 'incomplete'});
    } finally {value.close();}
});

test('an async observer cannot resolve charges after its synchronous callback scope', async () => {
    let shadow: demand.ActionProofDemandShadow;
    const value = await fixture(async token => {shadow.observe(token); throw new Error('controlled async observer rejection');});
    try {
        shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 1, maximumBytes: 1024});
        shadow.retain({owner: value.owner, source: {...value.source, selectionId: null}, admissionId: value.admissionId,
            traceOrdinal: 0, payload: value.payload, headers: value.headers, stage: 'ds-input'});
        const bytes = shadow.snapshot().knownPendingBytes;
        expect(await value.adjudicator.adjudicate(value.end)).toEqual({state: 'associated', id: 'private-association'});
        expect(shadow.snapshot()).toMatchObject({pendingDemands: 1, resolvedDemands: 0, knownPendingBytes: bytes,
            accounting: 'incomplete', transitions: {failures: 1}});
    } finally {value.close();}
});

test('invalid bounds and unsafe source accounting cannot create a tracked demand', async () => {
    const value = await fixture(() => {});
    try {
        for (const limits of [{maximumDemands: 0, maximumBytes: 1024}, {maximumDemands: 1.5, maximumBytes: 1024},
            {maximumDemands: 4097, maximumBytes: 1024}, {maximumDemands: 1, maximumBytes: NaN},
            {maximumDemands: 1, maximumBytes: 128 * 1024 * 1024 + 1}])
            expect(() => new demand.ActionProofDemandShadow(value.adjudicator, limits)).toThrow('Invalid bounded');
        const shadow = new demand.ActionProofDemandShadow(value.adjudicator, {maximumDemands: 1, maximumBytes: 1024});
        expect(shadow.retain({owner: value.owner, source: {...value.source, blockNum: Number.MAX_SAFE_INTEGER + 1, selectionId: null},
            admissionId: value.admissionId, traceOrdinal: 0, payload: value.payload, stage: 'ds-input'})).toBeUndefined();
        expect(shadow.snapshot()).toMatchObject({accounting: 'incomplete', retainedDemands: 0,
            rejectedRetains: 1, omittedDemands: 1, omittedKnownBytesLowerBound: 26});
    } finally {value.close();}
});
