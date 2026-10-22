import {describe, expect, it} from 'bun:test';
import {ProtocolNativeActionReader, ProtocolNativeActionUnavailableError} from '../../src/indexer/protocol/native-authorization.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiProofReader} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolNativeObservationStore} from '../../src/indexer/protocol/native-observation-store.js';
import {protocolSourceObservationLinkId} from '../../src/indexer/protocol/source-bindings.js';
import {blockId, chain, chainId, clone, gate, holdRead, nativeAuthorizationFixture, profile, schemaJson}
    from './protocol-native-authorization-host-fixture.js';

async function unavailable(operation: Promise<unknown>, code?: string) {
    let error: unknown; try {await operation;} catch (caught) {error = caught;}
    expect(error).toBeInstanceOf(ProtocolNativeActionUnavailableError); expect(error).toMatchObject({statusCode: 503});
    if (code) expect(error).toMatchObject({code}); return error;
}
const open = (fixture: Awaited<ReturnType<typeof nativeAuthorizationFixture>>, reader = fixture.reader(), signal?: AbortSignal) =>
    reader.open(fixture.selected.source, fixture.selected.selectionId, {signal});
async function authorized(fixture: Awaited<ReturnType<typeof nativeAuthorizationFixture>>, reader = fixture.reader()) {
    const view = await open(fixture, reader), decision = await reader.authorize(view, fixture.selected.inputs[0]);
    expect(decision.kind).toBe('native'); if (decision.kind !== 'native') throw new Error('Expected native host fixture grant');
    return {reader, view, grant: decision.grant};
}
const writes = (calls: any[]) => calls.filter(call => ['createIndex', 'create', 'index'].includes(call.method));

describe('native authorization host-contract controls (synthetic protocol, actual coordinator/proof/journal)', () => {
    it('uses certified occurrence with unknown ABI, inherits notifications and keeps identical inline bytes independent', async () => {
        const fixture = await nativeAuthorizationFixture(), reader = fixture.reader(), before = fixture.memory.calls.length;
        const view = await open(fixture, reader);
        expect(Object.isFrozen(view)).toBe(true); expect(Object.keys(view)).toEqual([]);
        const proofReader = fixture.proofs(), proof = await proofReader.open(fixture.selected.source, fixture.selected.selectionId);
        expect(proof.bindings.every(input => input.stateId === null)).toBe(true);
        await expect(proofReader.action(proof, fixture.selected.inputs[0])).rejects.toMatchObject({code: 'abi_state_unavailable'});
        const native = await reader.authorize(view, fixture.selected.inputs[0]), notification = await reader.authorize(view, fixture.selected.inputs[1]);
        expect(native.kind).toBe('native'); expect(notification.kind).toBe('native');
        if (native.kind !== 'native' || notification.kind !== 'native') throw new Error('Expected certified native origins');
        expect(Object.isFrozen(native.grant)).toBe(true); expect(Object.keys(native.grant)).toEqual([]);
        expect(native.grant).not.toBe(notification.grant);
        expect(await reader.decodeValue(native.grant)).toEqual({rawHex: '0102'});
        expect(await reader.decodeValue(notification.grant)).toEqual({rawHex: '0102'});
        expect(await reader.authorize(view, fixture.selected.inputs[2])).toEqual({kind: 'contract'});
        expect(await reader.authorize(view, fixture.selected.inputs[3])).toEqual({kind: 'contract'});
        for (const index of [4, 5]) {
            const result = await reader.authorize(view, fixture.selected.inputs[index]);
            expect(result).toEqual({kind: 'incomplete', error: {code: 'unsupported_origin', message: 'Only this origin is unsupported'}});
            expect(Object.isFrozen(result)).toBe(true); if (result.kind === 'incomplete') expect(Object.isFrozen(result.error)).toBe(true);
        }
        expect(fixture.calls.contract).toBe(0); expect(fixture.calls.handshakes).toEqual([JSON.parse(schemaJson)]);
        expect(fixture.calls.closed).toBe(1); expect(writes(fixture.memory.calls.slice(before))).toEqual([]);
    });

    it('rejects forged, copied, serialized and sibling-reader views/grants instead of trusting handle shape', async () => {
        const fixture = await nativeAuthorizationFixture(), {reader, view, grant} = await authorized(fixture), sibling = fixture.reader();
        for (const candidate of [{}, {...view}, clone(view), JSON.parse(JSON.stringify(view)), Object.create(view), null, undefined, 'view'])
            await unavailable(reader.authorize(candidate as any, fixture.selected.inputs[0]), 'native_invalid_view');
        for (const candidate of [{}, {...grant}, clone(grant), JSON.parse(JSON.stringify(grant)), Object.create(grant), null, undefined, 'grant'])
            await unavailable(reader.decodeValue(candidate as any), 'native_invalid_grant');
        await unavailable(sibling.authorize(view, fixture.selected.inputs[0]), 'native_invalid_view');
        await unavailable(sibling.decodeValue(grant), 'native_invalid_grant');
        expect(await reader.decodeValue(grant)).toEqual({rawHex: '0102'});
    });

    it('requires exact lossless receipt/origin/raw identity and never evaluates caller accessors', async () => {
        const fixture = await nativeAuthorizationFixture(), {reader, view} = await authorized(fixture), original = fixture.selected.inputs[0];
        for (const changed of [{transactionId: 'b'.repeat(64)}, {actionOrdinal: 2}, {inputActionOrdinal: 3}, {receiver: 'notified'},
            {account: 'other'}, {name: 'other'}, {rawHex: '0103'}, {globalSequence: '9007199254740992'},
            {globalSequence: Number(original.globalSequence)}, {receiptAbiSequence: '0'}, {extra: 'native'}])
            await unavailable(reader.authorize(view, {...original, ...changed} as any), 'native_input_mismatch');
        for (const input of [null, undefined, [], {}, Symbol('input')]) await unavailable(reader.authorize(view, input as any));
        let getters = 0;
        const hostile = Object.defineProperty({...original}, 'rawHex', {enumerable: true, get() {getters++; throw new Error('must not run');}});
        await unavailable(reader.authorize(view, hostile), 'native_input_mismatch'); expect(getters).toBe(0);
        await unavailable(reader.open({...fixture.selected.source, chainId: 'e'.repeat(64)}, fixture.selected.selectionId));
        await unavailable(reader.open({...fixture.selected.source, blockId: 'e'.repeat(64)}, fixture.selected.selectionId));
    });

    it('snapshots open requests and authorization input before awaited storage', async () => {
        const fixture = await nativeAuthorizationFixture(), reader = fixture.reader(), request = clone(fixture.selected.source);
        let held = holdRead(fixture.client, call => call.index === fixture.frontier.controlIndex);
        const opening = reader.open(request, fixture.selected.selectionId); await held.entered;
        request.blockId = blockId(99); held.release(); const view = await opening; held.restore();
        const input = clone(fixture.selected.inputs[0]); held = holdRead(fixture.client, call => call.index === fixture.frontier.controlIndex);
        const pending = reader.authorize(view, input); await held.entered;
        input.rawHex = '99'; input.globalSequence = '1'; held.release(); const result = await pending; held.restore();
        expect(result.kind).toBe('native');
        if (result.kind === 'native') expect(await reader.decodeValue(result.grant)).toEqual({rawHex: '0102'});
    });

    it('compares loader-selected component/context identity without importing journal-selected executable code', async () => {
        const fixture = await nativeAuthorizationFixture();
        for (const change of [
            (value: any) => {value.id = 'other-package';}, (value: any) => {value.components[0].sha256 = 'e'.repeat(64);},
            (value: any) => {value.components[0].sourceRevision = 'e'.repeat(40);},
            (value: any) => {value.components[0].version = '1.0.0';}, (value: any) => {value.components[0].runtime = 'rust';},
        ]) {
            const selected = clone(profile); change(selected);
            await unavailable(open(fixture, fixture.reader({profile: selected})), 'native_source_mismatch');
        }
        expect(() => fixture.reader({provider: {...fixture.provider, profileId: 'different'}})).toThrow();
        expect(() => fixture.reader({provider: {...fixture.provider, nativeActions: undefined}})).toThrow();
        const shuffled = clone(profile); shuffled.components = [...shuffled.components].reverse();
        expect(Object.isFrozen(await open(fixture, fixture.reader({profile: shuffled})))).toBe(true);
    });

    for (const [name, mutateRecord] of [
        ['inventory digest', (record: any) => {record.inventory.sha256 = 'e'.repeat(64);}],
        ['omitted decision', (record: any) => {record.observation.facts.decisions.pop(); record.inventory.firstReceiverCount--;}],
        ['changed decision', (record: any) => {record.observation.facts.decisions[0] = {...record.observation.facts.decisions[0], kind: 'contract'}; delete record.observation.facts.decisions[0].nativeKind;}],
        ['changed native kind', (record: any) => {record.observation.facts.decisions[0].nativeKind = 'different.kind';}],
        ['changed raw digest', (record: any) => {record.observation.facts.decisions[0].origin.rawSha256 = 'e'.repeat(64);}],
        ['changed order', (record: any) => {record.observation.facts.decisions.reverse();}],
    ] as const) it(`re-derives original membership and refuses self-consistent journal ${name}`, async () => {
        const fixture = await nativeAuthorizationFixture({mutateRecord}); await unavailable(open(fixture), 'native_source_mismatch');
    });

    it('refuses whole-source incomplete evidence, changed retained sections, invalid ancestry and canonical membership disagreement', async () => {
        const incomplete = await nativeAuthorizationFixture({mutateRecord(record) {
            record.inventory = null; record.observation = {status: 'incomplete', error: {code: 'missing', message: 'Source incomplete'}};
        }}); await unavailable(open(incomplete), 'native_source_incomplete');
        const changedRaw = await nativeAuthorizationFixture({mutateTraces(traces) {traces[0][1].action_traces[0][1].act.data = '99';}});
        await unavailable(open(changedRaw));
        const badAncestry = await nativeAuthorizationFixture({mutateTraces(traces) {traces[0][1].action_traces[1][1].creator_action_ordinal = 4;}});
        await unavailable(open(badAncestry), 'native_verification_unavailable');
        const differentBlock = await nativeAuthorizationFixture({mutateBlock(block) {block.source.blockId = blockId(99);}});
        await unavailable(open(differentBlock), 'native_verification_unavailable');
        for (const mutateInputs of [(inputs: any[]) => {inputs[0].receiptAbiSequence = '0';}, (inputs: any[]) => {inputs.pop();}]) {
            const changedCanonical = await nativeAuthorizationFixture({mutateInputs});
            await unavailable(open(changedCanonical), 'native_source_mismatch');
        }
    });

    for (const scope of ['link', 'native', 'context', 'selection', 'abi-link', 'abi']) for (const fault of ['missing', 'corrupt', 'missing-chunk'])
        it(`fails unavailable on ${fault} retained ${scope}, without provisioning or trusting an existing label`, async () => {
            const fixture = await nativeAuthorizationFixture(), retained = fixture.selected.retained;
            const targets = {link: [fixture.nativeStore.index, retained.linkId], native: [fixture.nativeStore.index, retained.link.observationId],
                context: [fixture.bindings.index, fixture.contextId], selection: [fixture.bindings.index, fixture.selected.selectionId],
                'abi-link': [fixture.bindings.index, protocolSourceObservationLinkId(fixture.selected.selectionId)],
                abi: [fixture.observations.index, fixture.selected.abi.id]};
            const [index, id] = targets[scope as keyof typeof targets], entry = fixture.memory.documents.get(fixture.memory.key(index, id));
            if (fault === 'missing') fixture.memory.documents.delete(fixture.memory.key(index, id));
            else if (fault === 'missing-chunk') fixture.memory.documents.delete(fixture.memory.key(index, entry.document.chunk_ids[0]));
            else fixture.memory.documents.get(fixture.memory.key(index, entry.document.chunk_ids[0])).document.payload = 'AA==';
            const before = fixture.memory.calls.length;
            await unavailable(open(fixture), fault === 'missing' ? 'native_retained_missing' : fault === 'missing-chunk' ? 'native_retained_incomplete' : 'native_retained_invalid');
            expect(writes(fixture.memory.calls.slice(before))).toEqual([]);
        });

    for (const scope of ['native', 'frontier-control', 'frontier-records', 'all'] as const)
        it(`converts supplied writer handles to detached readers when ${scope} indices are cold/missing`, async () => {
            const fixture = await nativeAuthorizationFixture();
            const coldIndices = scope === 'all' ? [...fixture.memory.mappings.keys()]
                : scope === 'native' ? [fixture.nativeStore.index]
                : scope === 'frontier-control' ? [fixture.frontier.controlIndex] : [fixture.frontier.recordsIndex];
            for (const index of coldIndices) {
                fixture.memory.mappings.delete(index); fixture.memory.settings.delete(index);
                for (const documentKey of fixture.memory.documents.keys())
                    if (documentKey.startsWith(index + '\0')) fixture.memory.documents.delete(documentKey);
            }
            const before = fixture.memory.calls.length;
            const reader = new ProtocolNativeActionReader({chainId, profile, provider: fixture.provider,
                store: new ProtocolNativeObservationStore(fixture.client, chain),
                proofReader: new ProtocolAbiProofReader({chainId, profile, store: new ProtocolAbiFrontierStore(fixture.client, chain)})});
            await unavailable(open(fixture, reader));
            expect(writes(fixture.memory.calls.slice(before))).toEqual([]);
            expect(coldIndices.every(index => !fixture.memory.mappings.has(index) && !fixture.memory.settings.has(index))).toBe(true);
        });

    it('keeps native kinds opaque and refuses an unsupported kind without falling back to contract ABI', async () => {
        const fixture = await nativeAuthorizationFixture({mutateRecord(record: any) {
            record.observation.facts.decisions[0].nativeKind = 'opaque.host-unsupported.v1';
        }});
        fixture.faults.changeObserved = (facts: any) => {facts.decisions[0].nativeKind = 'opaque.host-unsupported.v1';};
        const issued = await authorized(fixture);
        await unavailable(issued.reader.decodeValue(issued.grant), 'native_value_unavailable');
        expect(fixture.calls.contract).toBe(0);
    });

    it('preserves the configured ancestry bound instead of accepting an old source by widening it', async () => {
        const fixture = await nativeAuthorizationFixture({maxAncestryBlocks: 1});
        await fixture.append(3); await fixture.append(4);
        await unavailable(open(fixture), 'ancestry_unavailable');
        expect(fixture.calls.observe).toBe(0);
    });

    for (const phase of ['open', 'authorize', 'decode'] as const) it(`rejects canonical owner revocation across awaited ${phase} reads`, async () => {
        const fixture = await nativeAuthorizationFixture(), reader = fixture.reader();
        const issued = phase === 'open' ? undefined : await authorized(fixture, reader);
        const held = holdRead(fixture.client, call => phase === 'open' ? call.index === fixture.nativeStore.index : call.index === fixture.frontier.controlIndex);
        const pending = phase === 'open' ? open(fixture, reader) : phase === 'authorize'
            ? reader.authorize(issued!.view, fixture.selected.inputs[0]) : reader.decodeValue(issued!.grant);
        await held.entered; await fixture.replaceOwner(); held.release(); await unavailable(pending); held.restore();
        if (issued) await unavailable(reader.decodeValue(issued.grant));
    });

    it('invalidates issued grants on actual fork rewind or revoked physical source', async () => {
        for (const fault of ['fork', 'revoke']) {
            const fixture = await nativeAuthorizationFixture(), issued = await authorized(fixture);
            if (fault === 'fork') await fixture.append(2, 20, 1); else await fixture.revoke();
            await unavailable(issued.reader.decodeValue(issued.grant));
            await unavailable(issued.reader.authorize(issued.view, fixture.selected.inputs[0]));
        }
    });

    it('carries one signal to every nested read and preserves exact pre-abort/late-abort reasons without affecting siblings', async () => {
        const fixture = await nativeAuthorizationFixture(), reader = fixture.reader(), signals: any[] = [], controller = new AbortController();
        for (const [owner, name] of [[fixture.client, 'get'], [fixture.client.indices, 'getMapping'], [fixture.client.indices, 'getSettings']] as const) {
            const original = owner[name]; owner[name] = (request: any, options: any) => {signals.push(options?.signal); return original(request, options);};
        }
        const view = await open(fixture, reader, controller.signal), result = await reader.authorize(view, fixture.selected.inputs[0], {signal: controller.signal});
        if (result.kind !== 'native') throw new Error('Expected native grant');
        await reader.decodeValue(result.grant, {signal: controller.signal});
        expect(signals.length).toBeGreaterThan(10); expect(signals.every(signal => signal === controller.signal)).toBe(true);
        const aborted = new AbortController(), exact = Symbol('exact abort'); aborted.abort(exact);
        const before = fixture.memory.calls.length;
        await expect(reader.open(null as any, 'bad', {signal: aborted.signal})).rejects.toBe(exact);
        await expect(reader.authorize(null as any, null as any, {signal: aborted.signal})).rejects.toBe(exact);
        await expect(reader.decodeValue(null as any, {signal: aborted.signal})).rejects.toBe(exact);
        expect(fixture.memory.calls.length).toBe(before);
        const held = holdRead(fixture.client, call => call.index === fixture.nativeStore.index), late = new AbortController();
        const pending = open(fixture, reader, late.signal); await held.entered;
        const sibling = await open(fixture, fixture.reader()); expect(Object.isFrozen(sibling)).toBe(true);
        const reason = Object.freeze({caller: 'cancelled'}); late.abort(reason); held.release();
        await expect(pending).rejects.toBe(reason); held.restore();
        expect(await reader.decodeValue(result.grant)).toEqual({rawHex: '0102'});
    });

    it('bounds concurrent openings, isolates another reader and releases the budget after cancellation', async () => {
        const fixture = await nativeAuthorizationFixture(), reader = fixture.reader(), entered = gate(), release = gate(), abort = new AbortController();
        let waiting = 0;
        fixture.memory.faults.beforeRead = async (request: any) => {
            if (request.index === fixture.nativeStore.index && waiting < 8) {waiting++; if (waiting === 8) entered.release(); await release.promise;}
        };
        const pending = Array.from({length: 8}, () => open(fixture, reader, abort.signal).catch(error => error));
        await entered.promise; await unavailable(open(fixture, reader), 'native_busy');
        expect(Object.isFrozen(await open(fixture, fixture.reader()))).toBe(true);
        const reason = Symbol('bounded cancelled'); abort.abort(reason); release.release();
        for (const error of await Promise.all(pending)) expect(error).toBe(reason);
        fixture.memory.faults.beforeRead = undefined; expect(Object.isFrozen(await open(fixture, reader))).toBe(true);
    });

    it('rejects observer/decoder raw mutation, arbitrary provider errors and changed value encodings', async () => {
        for (const fault of ['observeMutates', 'traceMutates', 'observeThrows', 'traceDecodeThrows']) {
            const fixture = await nativeAuthorizationFixture(); fixture.faults[fault] = true;
            await unavailable(open(fixture), 'native_verification_unavailable');
        }
        for (const fault of ['decodeMutates', 'encodeDifferent', 'decodeThrows', 'encodeThrows']) {
            const fixture = await nativeAuthorizationFixture(), issued = await authorized(fixture); fixture.faults[fault] = true;
            await unavailable(issued.reader.decodeValue(issued.grant), ['decodeMutates', 'encodeDifferent'].includes(fault) ? 'native_value_mismatch' : 'native_value_unavailable');
        }
        const fixture = await nativeAuthorizationFixture(), issued = await authorized(fixture), abort = new AbortController(), reason = Symbol('provider abort');
        fixture.faults.onDecode = () => abort.abort(reason); fixture.faults.encodeThrows = true;
        await expect(issued.reader.decodeValue(issued.grant, {signal: abort.signal})).rejects.toBe(reason);
    });

    it('never assimilates async native values or invokes then accessors, including properties inserted by the encoder', async () => {
        for (const phase of ['promise', 'thenable', 'accessor', 'encoder-accessor']) {
            const fixture = await nativeAuthorizationFixture(), issued = await authorized(fixture); let getters = 0;
            const value = {rawHex: '0102'};
            if (phase === 'promise') fixture.faults.decodedValue = Promise.resolve(value);
            if (phase === 'thenable') fixture.faults.decodedValue = {...value, then() {throw new Error('Never assimilate');}};
            const addAccessor = (target: any) => Object.defineProperty(target, 'then', {get() {getters++; throw new Error('Never read');}});
            if (phase === 'accessor') fixture.faults.decodedValue = addAccessor(value);
            if (phase === 'encoder-accessor') fixture.faults.onEncode = addAccessor;
            await unavailable(issued.reader.decodeValue(issued.grant)); expect(getters).toBe(0);
            expect(fixture.calls.encode).toBe(phase === 'encoder-accessor' ? 1 : 0);
        }
    });

    it('translates opaque storage failures to unavailable without inspecting/coercing them, with cancellation precedence', async () => {
        for (const abortRead of [false, true]) {
            const fixture = await nativeAuthorizationFixture(), abort = new AbortController(), exact = Symbol('cancel beats read'); let getters = 0;
            const opaque = Object.defineProperty({}, 'message', {get() {getters++; throw new Error('Never inspect');}});
            fixture.memory.faults.beforeRead = () => {if (abortRead) abort.abort(exact); throw opaque;};
            const opening = open(fixture, fixture.reader(), abort.signal);
            if (abortRead) await expect(opening).rejects.toBe(exact); else await unavailable(opening, 'native_read_unavailable');
            expect(getters).toBe(0);
        }
    });
});
