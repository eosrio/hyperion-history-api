import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateProtocolNativeActions} from '@eosrio/hyperion-sdk/protocol';
import {createWireNativeActions, resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';
import {loadChainProtocol} from '../../build/indexer/protocol/selection.js';
import {ProtocolAbiCoordinator} from '../../build/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiProofReader} from '../../build/indexer/protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiObservationStore, protocolAbiCaptureDigest} from '../../build/indexer/protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {ProtocolNativeObservationStore} from '../../build/indexer/protocol/native-observation-store.js';
import {ProtocolNativeActionReader} from '../../build/indexer/protocol/native-authorization.js';
import {protocolNativeInputInventory, snapshotProtocolNativeDecisions} from '../../build/indexer/protocol/native-observation-facts.js';
import {deriveProtocolActionOccurrences} from '../../build/indexer/history/action-source-inventory.js';
import {protocolBytes} from '../../build/indexer/protocol/contract-cache.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const archive = join(repo, 'tests/fixtures/portable-state-worker');
const wireRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
const originals = join(wireRoot, 'fixtures/codec/native-onblock-6508-20261022');

/** Original Wire source plus actual coordinator/proof/journals. Only ES transport is in memory.
 * The native capability is an explicitly engineered selection after the unchanged installed loader.
 */
export async function nativeApiWireSource({nativeMarker = true} = {}) {
    assert.equal(hash(readFileSync(join(archive, 'source-1-1480-20261020.tar.gz'))), '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    const manifest = JSON.parse(readFileSync(join(originals, 'manifest.json')));
    for (const row of manifest.members) {
        const bytes = readFileSync(join(originals, row.path)); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256);
    }
    const expected = new Map(JSON.parse(readFileSync(join(originals, 'expected.json'))).map(value => [value.blockNum, value]));
    const directory = mkdtempSync(join(tmpdir(), 'hapi-native-api-original-'));
    const extraction = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [join(archive, 'prepare.py'), join(directory, 'capture')],
        {encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024});
    assert.equal(extraction.status, 0, extraction.stderr);
    assert.equal(JSON.parse(extraction.stdout).files, 1488);
    const sourceDir = join(directory, 'capture/source'), schemaJson = readFileSync(join(sourceDir, 'schema.json'), 'utf8');
    assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
    const receipt = JSON.parse(readFileSync(join(sourceDir, 'receipt.json'))), index = new Map(receipt.frames.map(row => [row.blockNum, row]));
    const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d', chain = 'native-api-wire-original';
    assert.equal(receipt.chainId, chainId); assert.equal(receipt.complete, true);
    const installed = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: manifest.profileId});
    assert.equal(installed.provider.nativeActions, undefined);
    assert(installed.components.every(component => component.sourceRevision === 'cffef8f3ec12f662bac98e17cb9433b9fac4ab79'));
    const capability = validateProtocolNativeActions(createWireNativeActions(resolveCodecProfile(manifest.profileId)), {interfaceVersion: 1});
    assert.equal(capability.valid, true);
    const provider = {...installed.provider, nativeActions: capability.nativeActions}, selected = {...installed, provider};
    const profile = {id: selected.id, profileId: provider.profileId, components: selected.components};
    const memory = frontierMemoryClient(), client = memory.client;
    const bindings = new ProtocolSourceBindingStore(client, chain), observations = new ProtocolAbiObservationStore(client, chain);
    const frontier = new ProtocolAbiFrontierStore(client, chain), nativeStore = new ProtocolNativeObservationStore(client, chain);
    const proofReader = new ProtocolAbiProofReader({chainId, profile, store: frontier});
    const nativeReader = new ProtocolNativeActionReader({chainId, profile, provider, store: nativeStore, proofReader});
    const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson})).id;
    const coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'native-api-original-owner', bindings, observations, store: frontier,
        verifyNativeGenesis: provider.verifyNativeGenesis.bind(provider), ...(nativeMarker ? {nativeActionInterfaceVersion: 1} : {})});
    await coordinator.start(); let {generation} = await coordinator.openSource(contextId, 'native-api-original-reader');
    const session = provider.createShipSession(JSON.parse(schemaJson)), retained = new Map(); let height = 0, parent = null;
    async function appendUntil(last) {
        for (let number = height + 1; number <= last; number++) {
            const frame = readFileSync(join(sourceDir, 'block-' + String(number).padStart(6, '0') + '.bin')), sourceFrame = index.get(number);
            assert.equal(frame.length, sourceFrame.bytes); assert.equal(hash(frame), sourceFrame.sha256);
            const result = session.decodeResult(frame); assert.equal(result[0], 'get_blocks_result_v0'); const res = result[1];
            const source = {chainId, blockNum: Number(res.this_block.block_num), blockId: res.this_block.block_id.toString(),
                previousBlockId: res.prev_block?.block_id.toString() ?? null};
            assert.equal(source.blockNum, number); assert.equal(source.previousBlockId, parent); assert.equal(source.blockId, sourceFrame.blockId);
            const section = value => value === null || value === undefined ? null : Buffer.from(protocolBytes(value)).toString('hex');
            const capture = {kind: 'unattested-ship-result-sections-v1', schemaJson, blockHex: section(res.block), tracesHex: section(res.traces), deltasHex: section(res.deltas)};
            const captureSha256 = protocolAbiCaptureDigest(source, capture), header = session.decodeBlock(Buffer.from(capture.blockHex, 'hex'));
            const accountRows = []; let ordinal = 0;
            for (const [, delta] of session.decodeDeltas(Buffer.from(capture.deltasHex, 'hex'))) for (const row of delta.rows) {
                if (delta.name === 'account') {const raw = protocolBytes(row.data); accountRows.push({ordinal, present: row.present === true || row.present === 1, raw, value: session.decodeRow('account', raw)});}
                ordinal++;
            }
            const traces = capture.tracesHex ? session.decodeTraces(Buffer.from(capture.tracesHex, 'hex')) : [];
            const occurrences = deriveProtocolActionOccurrences(traces), inputs = occurrences.map(value => value.input);
            const observation = number === 1 ? {status: 'native-genesis', facts: provider.verifyNativeGenesis({schemaJson,
                block: Buffer.from(capture.blockHex, 'hex'), traces: null, deltas: Buffer.from(capture.deltasHex, 'hex')}, source)}
                : {status: 'observed', facts: provider.observeBlockAbi({traces, accountRows}, source)};
            const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, source, readerSessionId: 'native-api-original-reader',
                readerRole: 'live', assignmentId: null, frameSha256: hash(frame), captureSha256,
                head: {blockNum: Number(res.head.block_num), blockId: res.head.block_id.toString()},
                irreversible: {blockNum: Number(res.last_irreversible.block_num), blockId: res.last_irreversible.block_id.toString()}})).id;
            const abi = await observations.prepare({schemaVersion: 1, protocol: profile, source: {...source, inputSha256: captureSha256}, capture, observation});
            await bindings.prepareObservationLink({schemaVersion: 1, selectionId, observationId: abi.id, observationDigest: abi.digest});
            if (number > 1) await nativeStore.prepare(selectionId, {schemaVersion: 1, kind: 'observation', nativeInterfaceVersion: 1,
                contextId, protocol: profile, source, captureRef: {abiObservationId: abi.id, abiObservationDigest: abi.digest, inputSha256: captureSha256},
                inventory: protocolNativeInputInventory(inputs), observation: {status: 'observed', facts: snapshotProtocolNativeDecisions(
                    capability.nativeActions.observe({schemaJson, block: Buffer.from(capture.blockHex, 'hex'), traces: Buffer.from(capture.tracesHex, 'hex')}, source), inputs)}});
            assert.equal((await coordinator.admit(selectionId, generation)).status, 'accepted');
            await coordinator.drain(); generation = (await coordinator.inspect()).generation;
            retained.set(number, {source, selectionId, header, occurrences}); height = number; parent = source.blockId;
        }
    }
    async function action(number, ordinal) {
        const block = retained.get(number), expectedValue = expected.get(number);
        const occurrence = block.occurrences.find(value => value.input.actionOrdinal === (ordinal ?? expectedValue?.actionOrdinal ?? 1));
        assert(occurrence); const input = occurrence.input;
        const view = await nativeReader.open(block.source, block.selectionId), decision = await nativeReader.authorize(view, input);
        assert.equal(decision.kind, 'native');
        const metadata = await nativeReader.metadata(decision.grant), value = await nativeReader.decodeValue(decision.grant);
        if (expectedValue) {assert.equal(input.rawHex, expectedValue.rawHex); assert.deepEqual(value, expectedValue.expectedValue);}
        return {'@timestamp': block.header.timestamp, block_num: number, block_id: block.source.blockId, producer: block.header.producer,
            trx_id: input.transactionId, action_ordinal: input.actionOrdinal, creator_action_ordinal: occurrence.creatorActionOrdinal,
            global_sequence: input.globalSequence, code_sequence: occurrence.receipt.code_sequence, abi_sequence: occurrence.receipt.abi_sequence,
            act_digest: occurrence.actDigest, act: {account: input.account, name: input.name, authorization: structuredClone(occurrence.authorization), data: value},
            receipts: [structuredClone(occurrence.receipt)], protocol: metadata};
    }
    return {chainId, chain, selected, installed, provider, profile, memory, client, frontier, nativeStore, coordinator,
        expected, retained, appendUntil, action, async dispose() {
            session.close?.(); assert.equal(installed.provider.nativeActions, undefined);
            const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir())); assert(basename(target).startsWith('hapi-native-api-original-'));
            rmSync(target, {recursive: true, force: true});
        }};
}
