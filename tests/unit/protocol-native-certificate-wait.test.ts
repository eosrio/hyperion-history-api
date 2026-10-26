import {expect, test} from 'bun:test';
import {ProtocolNativeActionUnavailableError} from '../../src/indexer/protocol/native-authorization.js';
import {nativeAuthorizationFixture, gate, holdRead} from './protocol-native-authorization-host-fixture.js';

/** Synthetic protocol only; the actual coordinator publishes the next head before this held PREPARE. */
async function heldNextCertificate(fixture: Awaited<ReturnType<typeof nativeAuthorizationFixture>>) {
    const entered = gate(), release = gate(), original = fixture.frontier.prepareCertificate.bind(fixture.frontier);
    let certificateId = '';
    fixture.frontier.prepareCertificate = async value => {
        if ((value as any).head.blockNum === 3) {certificateId = fixture.frontier.certificateId(value); entered.release(); await release.promise;}
        return original(value);
    };
    const append = fixture.append(3); await entered.promise;
    expect((await fixture.frontier.readControl())!.value.head!.blockNum).toBe(3);
    expect(fixture.memory.documents.has(fixture.memory.key(fixture.frontier.recordsIndex, certificateId))).toBe(false);
    return {certificateId, async finish() {release.release(); await append; fixture.frontier.prepareCertificate = original;}};
}
const writes = (calls: any[]) => calls.filter(call => ['createIndex', 'create', 'index'].includes(call.method));

test('native worker wait survives the next-head certificate gap after an earlier ABI wait without changing immediate opens', async () => {
    const fixture = await nativeAuthorizationFixture({nativeActionInterfaceVersion: 1}), reader = fixture.reader();
    await fixture.proofs().waitForOpen(fixture.selected.source, fixture.selected.selectionId);
    const held = await heldNextCertificate(fixture), attempted = gate();
    try {
        await expect(reader.open(fixture.selected.source, fixture.selected.selectionId)).rejects.toMatchObject({
            code: 'certificate_unavailable', message: 'Immutable protocol bundle is missing'});
        fixture.memory.faults.beforeRead = request => {if (request.id === held.certificateId) attempted.release();};
        const source = structuredClone(fixture.selected.source), before = fixture.memory.calls.length;
        let settled = false;
        const waiting = reader.waitForOpen(source, fixture.selected.selectionId, {timeoutMs: 1000})
            .then(value => {settled = true; return value;}, error => {settled = true; throw error;});
        source.blockId = 'f'.repeat(64);
        await attempted.promise; expect(settled).toBe(false); expect(writes(fixture.memory.calls.slice(before))).toEqual([]);
        await held.finish(); const view = await waiting;
        const decision = await reader.authorize(view, fixture.selected.inputs[0]); expect(decision.kind).toBe('native');
        if (decision.kind !== 'native') throw new Error('Original native input must remain authorized');
        expect(await reader.decodeValue(decision.grant)).toEqual({rawHex: fixture.selected.inputs[0].rawHex});
        expect(fixture.calls.contract).toBe(0);
    } finally {delete fixture.memory.faults.beforeRead; await held.finish();}
});

test('native canonical wait times out without issuing a view or retrying native evidence and releases its read slot', async () => {
    const fixture = await nativeAuthorizationFixture({nativeActionInterfaceVersion: 1}), reader = fixture.reader();
    const held = await heldNextCertificate(fixture), before = fixture.calls.observe;
    try {
        await expect(reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId, {timeoutMs: 20})).rejects.toMatchObject({
            name: 'ProtocolNativeActionUnavailableError', code: 'proof_timeout', statusCode: 503});
        expect(fixture.calls.observe).toBe(before);
    } finally {await held.finish();}
    expect(Object.isFrozen(await reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId))).toBe(true);
});

test('native canonical wait preserves exact cancellation and does not cancel an independent sibling', async () => {
    const fixture = await nativeAuthorizationFixture({nativeActionInterfaceVersion: 1}), reader = fixture.reader();
    const held = await heldNextCertificate(fixture), attempted = gate(), controller = new AbortController(), reason = {request: 'cancelled'};
    fixture.memory.faults.beforeRead = request => {if (request.id === held.certificateId) attempted.release();};
    try {
        const waiting = reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId, {timeoutMs: 1000, signal: controller.signal}).catch(error => error);
        const sibling = fixture.reader().waitForOpen(fixture.selected.source, fixture.selected.selectionId, {timeoutMs: 1000});
        await attempted.promise; controller.abort(reason); expect(await waiting).toBe(reason);
        await held.finish(); expect(Object.isFrozen(await sibling)).toBe(true);
        const calls = fixture.memory.calls.length;
        await expect(reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId, {signal: controller.signal})).rejects.toBe(reason);
        expect(fixture.memory.calls.length).toBe(calls);
    } finally {delete fixture.memory.faults.beforeRead; await held.finish();}
});

test('native wait preserves cancellation during later retained native reads without releasing a successful handle', async () => {
    const fixture = await nativeAuthorizationFixture(), reader = fixture.reader(), controller = new AbortController(), reason = Symbol('late native abort');
    const held = holdRead(fixture.client, request => request.index === fixture.nativeStore.index);
    const waiting = reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId, {signal: controller.signal}).catch(error => error);
    await held.entered; controller.abort(reason); held.release(); expect(await waiting).toBe(reason); held.restore();
    expect(Object.isFrozen(await reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId))).toBe(true);
});

test('native wait fails closed on explicit incomplete and corrupt evidence without retrying or writing it', async () => {
    for (const fault of ['incomplete', 'corrupt'] as const) {
        const fixture = await nativeAuthorizationFixture(fault === 'incomplete' ? {mutateRecord(record) {
            record.inventory = null; record.observation = {status: 'incomplete', error: {code: 'missing', message: 'Original evidence is incomplete'}};
        }} : {});
        if (fault === 'corrupt') {
            const manifest = fixture.memory.documents.get(fixture.memory.key(fixture.nativeStore.index, fixture.selected.retained.link.observationId))!;
            fixture.memory.documents.get(fixture.memory.key(fixture.nativeStore.index, manifest.document.chunk_ids[0]))!.document.payload = 'AA==';
        }
        const reader = fixture.reader(), before = fixture.memory.calls.length;
        await expect(reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId)).rejects.toMatchObject({
            code: fault === 'incomplete' ? 'native_source_incomplete' : 'native_retained_invalid'});
        expect(writes(fixture.memory.calls.slice(before))).toEqual([]); expect(fixture.calls.observe).toBe(0);
        expect(fixture.memory.calls.slice(before).filter((call: any) => call.method === 'get' && call.request.id === fixture.selected.retained.link.observationId)).toHaveLength(1);
    }
});

test('native wait cannot turn an old canonical read into a grant after actual coordinator fork replacement', async () => {
    const fixture = await nativeAuthorizationFixture({nativeActionInterfaceVersion: 1}), reader = fixture.reader();
    const held = holdRead(fixture.client, request => request.index === fixture.frontier.controlIndex);
    const waiting = reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId).catch(error => error);
    await held.entered; await fixture.append(2, 20, 1); held.release(); const error = await waiting; held.restore();
    expect(error).toBeInstanceOf(ProtocolNativeActionUnavailableError); expect(error).toMatchObject({code: 'authority_changed'});
    await expect(reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId)).rejects.toMatchObject({code: 'source_not_canonical'});
});

test('settled native wait remains read-only and rejects copied issued authority', async () => {
    const fixture = await nativeAuthorizationFixture(), reader = fixture.reader(), before = fixture.memory.calls.length;
    const view = await reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId);
    expect(writes(fixture.memory.calls.slice(before))).toEqual([]);
    await expect(reader.authorize({...view}, fixture.selected.inputs[0])).rejects.toMatchObject({code: 'native_invalid_view'});
});
