import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProtocolNativeActions} from '@eosrio/hyperion-sdk/protocol';
import {createWireNativeActions, createWireValueCodec, resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';
import {ProtocolAbiObservationStore} from '../../build/indexer/protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {ProtocolNativeObservationStore} from '../../build/indexer/protocol/native-observation-store.js';
import {protocolNativeInputInventory, snapshotProtocolNativeDecisions} from '../../build/indexer/protocol/native-observation-facts.js';
import {deriveProtocolActionInputs} from '../../build/indexer/history/action-source-inventory.js';
import {loadChainProtocol} from '../../build/indexer/protocol/selection.js';
import {protocolSourceCapture} from '../../build/indexer/workers/hyperionWorker.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Called only inside check-protocol-abi-store's owned, pinned disposable cluster lifecycle. */
export async function checkProtocolNativeJournal(client, chain, report, pipeline) {
    const root = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
    const originals = join(root, 'fixtures/codec/native-onblock-6508-20261022');
    const manifest = JSON.parse(readFileSync(join(originals, 'manifest.json')));
    for (const item of manifest.members) {
        const bytes = readFileSync(join(originals, item.path)); assert.equal(bytes.length, item.bytes); assert.equal(hash(bytes), item.sha256);
    }
    const schemaJson = readFileSync(resolve(originals, manifest.schema.path), 'utf8');
    assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
    const selected = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: manifest.profileId});
    assert.equal(selected.provider.nativeActions, undefined);
    const profile = resolveCodecProfile(manifest.profileId), codec = createWireValueCodec(JSON.parse(schemaJson), profile);
    const checked = validateProtocolNativeActions(createWireNativeActions(profile), {interfaceVersion: 1}); assert.equal(checked.valid, true);
    const native = checked.nativeActions, session = selected.provider.createShipSession(JSON.parse(schemaJson));
    const bounds = {chunkBytes: 256, maximumBytes: 32768, maximumChunks: 128};
    const bindings = new ProtocolSourceBindingStore(client, chain), abis = new ProtocolAbiObservationStore(client, chain);
    const store = new ProtocolNativeObservationStore(client, chain, 0, bounds);
    const protocol = {id: selected.id, profileId: manifest.profileId, components: selected.components};
    const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId: manifest.chainId, protocol, schemaJson})).id;
    const rows = [];
    const retain = async bytes => {
        const result = session.decodeResult(bytes)[1], captured = protocolSourceCapture(manifest.chainId, result, schemaJson);
        const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: 'disposable-native-journal',
            readerRole: 'bulk', assignmentId: null, source: captured.source, frameSha256: hash(bytes), captureSha256: captured.captureSha256,
            head: {blockNum: Number(result.head.block_num), blockId: String(result.head.block_id)},
            irreversible: {blockNum: Number(result.last_irreversible.block_num), blockId: String(result.last_irreversible.block_id)}})).id;
        // Deliberate ABI-incomplete control: native PREPARE does not claim ABI reduction/coverage.
        const abi = await abis.prepare({schemaVersion: 1, protocol, source: {...captured.source, inputSha256: captured.captureSha256},
            capture: captured.capture, observation: {status: 'incomplete', error: {code: 'engineering_abi_control', message: 'Independent native journal storage control'}}});
        await bindings.prepareObservationLink({schemaVersion: 1, selectionId, observationId: abi.id, observationDigest: abi.digest});
        const inputs = deriveProtocolActionInputs(session.decodeTraces(Buffer.from(captured.capture.tracesHex, 'hex')));
        const facts = snapshotProtocolNativeDecisions(native.observe({schemaJson, block: Buffer.from(captured.capture.blockHex, 'hex'),
            traces: Buffer.from(captured.capture.tracesHex, 'hex')}, captured.source), inputs);
        return {selectionId, record: {schemaVersion: 1, kind: 'observation', nativeInterfaceVersion: 1, contextId, protocol,
            source: captured.source, captureRef: {abiObservationId: abi.id, abiObservationDigest: abi.digest, inputSha256: captured.captureSha256},
            inventory: protocolNativeInputInventory(inputs), observation: {status: 'observed', facts}}};
    };
    try {
        for (const number of [33, 122, 397]) {
            const bytes = readFileSync(join(originals, `block-${String(number).padStart(6, '0')}.bin`));
            const input = await retain(bytes), opening = await store.prepare(input.selectionId, input.record);
            assert.equal(opening.record.source.blockNum, number); assert.equal(opening.record.observation.facts.decisions[0].kind, 'native');
            const cold = new ProtocolNativeObservationStore(client, chain, 0, bounds, {readOnly: true});
            assert.deepEqual(await cold.readSelection(input.selectionId), opening);
            assert.deepEqual(await store.prepare(input.selectionId, input.record), opening);
            rows.push({...input, opening, frameSha256: hash(bytes)});
        }
        await client.indices.putSettings({index: store.index, settings: {refresh_interval: '-1'}});
        const original = rows[0], derived = session.decodeResult(readFileSync(join(originals, 'block-000033.bin')));
        derived[1].deltas = '00';
        const receiptInput = await retain(Buffer.from(codec.encode('result', derived)));
        let deficient = true, cas = 0;
        const deficientClient = new Proxy(client, {get(target, key) {
            if (key === 'create' || key === 'index') return async (request, options) => {
                const value = await target[key](request, options);
                if (request.index !== store.index) return value;
                if (request.if_seq_no !== undefined) cas++;
                return deficient ? {...value, _shards: {...value._shards, successful: 0}} : value;
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        }});
        const receiptStore = new ProtocolNativeObservationStore(deficientClient, chain, 0, bounds);
        await assert.rejects(receiptStore.prepare(receiptInput.selectionId, receiptInput.record), /durable write receipt/);
        await assert.rejects(receiptStore.prepare(receiptInput.selectionId, receiptInput.record), /durable write receipt/);
        deficient = false; await receiptStore.prepare(receiptInput.selectionId, receiptInput.record); assert(cas > 0);
        await assert.rejects(store.prepare(original.selectionId, {...original.record, observation: {status: 'incomplete',
            error: {code: 'changed_labels', message: 'Changed outcome for identical original source'}}}), /Immutable.*conflict/);
        report.checks.push('native source references, cold reopen, multi-chunk PREPARE, immutable conflict and all-copy receipt/CAS recovery on Elasticsearch');

        const controller = new AbortController(), reason = Object.assign(new Error('Cancelled native capture read'), {meta: {statusCode: 404}});
        let enter, release; const entered = new Promise(r => {enter = r;}), held = new Promise(r => {release = r;}), signals = [];
        const delayed = new Proxy(client, {get(target, key) {
            if (key === 'create' || key === 'index') return async () => {throw new Error('Cold native reader attempted a write');};
            if (key === 'get') return async (request, options) => {
                signals.push(options?.signal);
                if (request.index === `${chain}-protocol-abi-observations-v1` && request.id === original.record.captureRef.abiObservationId) {
                    enter(); await held; throw new Error('Underlying capture transport completed after cancellation');
                }
                return target.get(request, options);
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        }});
        const delayedReader = new ProtocolNativeObservationStore(delayed, chain, 0, bounds, {readOnly: true});
        const pending = delayedReader.readSelection(original.selectionId, controller.signal);
        void pending.catch(() => {});
        let deadline;
        try {
            await Promise.race([entered, new Promise((_, reject) => {deadline = setTimeout(() => reject(new Error('Native capture read phase was not reached')), 5000);})]);
            const independent = await new ProtocolNativeObservationStore(client, chain, 0, bounds, {readOnly: true}).readSelection(original.selectionId);
            assert.deepEqual(independent, original.opening);
        } finally {clearTimeout(deadline); controller.abort(reason); release();}
        await assert.rejects(pending, error => error === reason);
        assert(signals.length > 1 && signals.every(signal => signal === controller.signal));
        report.checks.push('native nested capture cancellation preserves exact reason and signal while an independent cold reader completes');
        for (const [setting, value, failure] of [['translog.durability', 'async', /durability/], ['final_pipeline', pipeline, /retention/]]) {
            await client.indices.putSettings({index: store.index, settings: {[setting]: value}});
            try {await assert.rejects(new ProtocolNativeObservationStore(client, chain, 0, bounds, {readOnly: true}).readSelection(original.selectionId), failure);}
            finally {await client.indices.putSettings({index: store.index, settings: {[setting]: setting === 'final_pipeline' ? '_none' : 'request'}});}
        }
        report.nativeJournal = {originalFrames: rows.map(row => ({blockNum: row.record.source.blockNum, blockId: row.record.source.blockId,
            frameSha256: row.frameSha256, observationId: row.opening.link.observationId, inputInventory: row.record.inventory})),
            pins: protocol, chunkBytes: bounds.chunkBytes, receiptControlDerived: true, canonicalAuthority: false, nativeActivation: false,
            fullWorkerQualification: false};
    } finally {session.close?.(); selected.decoder.close?.();}
}
