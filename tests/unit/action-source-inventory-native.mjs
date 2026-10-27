/** Source-membership qualification only. Synthetic locator IDs grant no canonical/value authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadChainProtocol} from '../../build/indexer/protocol/selection.js';
import {deriveActionSourceInventory, deriveProtocolActionInputs, validateActionSourceTransactionOutput,
    ActionSourceInventoryError} from '../../build/indexer/history/action-source-inventory.js';
import {normalizeActionSequences} from '../../build/indexer/helpers/action-sequences.js';
import {groupActionTraces} from '../../build/indexer/helpers/action-dedup.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const legacyProfiles = ['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1'];
const wireRevision = '7167659e9c043cb3351074fcacb40200cc57f3a3';
const sdkRevision = '8d37e932df5e0e7d671c9682505de3dd55f0edb4';
const archiveSha256 = '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7';
const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = join(repo, 'tests/fixtures/portable-state-worker');
const wire = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
const original = join(wire, 'fixtures/codec/native-onblock-6508-20261022');
const readJson = path => JSON.parse(readFileSync(path));
const lock = readJson(join(repo, 'package-lock.json'));
assert.equal(lock.packages['node_modules/@eosrio/hyperion-wire-plugin'].resolved,
    `git+ssh://git@github.com/eosrio/hyperion-wire-plugin.git#${wireRevision}`);
assert.equal(lock.packages['node_modules/@eosrio/hyperion-sdk'].resolved,
    `git+ssh://git@github.com/eosrio/hyperion-sdk.git#${sdkRevision}`);
assert.equal(readJson(join(wire, 'dist/protocol-source-receipt.json')).sourceRevision, wireRevision);
assert.equal(hash(readFileSync(join(fixture, 'source-1-1480-20261020.tar.gz'))), archiveSha256);
const manifest = readJson(join(original, 'manifest.json'));
assert.equal(manifest.originalArchiveSha256, archiveSha256); assert.equal(manifest.chainId, chainId);
assert.equal(manifest.upstreamRevision, '6508c9e8f4044df8d5acb082a7af3be6a80cd9a0');
for (const member of manifest.members) {
    const bytes = readFileSync(join(original, member.path));
    assert.equal(bytes.length, member.bytes); assert.equal(hash(bytes), member.sha256);
}
assert.equal(hash(readFileSync(join(original, 'expected.json'))),
    'f2d022f14e493f2297034dd8e7e1846d1504f19bbf1278afee8cd30a955b9720');
const oracles = readJson(join(original, 'expected.json'));
assert.deepEqual(oracles.map(row => row.blockNum), [33, 122, 397]);
const policy = {schemaVersion: 1, parserVersion: '3.2', actionBlacklist: [], actionWhitelist: [],
    rootOnly: false, maxDepth: 0, maxInline: 0, eosioAlias: 'sysio'};

// Real selected profile/components, deliberately synthetic locator IDs. Their shape binds
// membership here; native authorization and durable worker grants have separate tests.
function nativeLocator(protocol, selected, nativeKind) {
    return {...protocol, schemaVersion: 2, kind: 'native', native: {nativeKind,
        contextId: 'h45srcctx1:' + '1'.repeat(64), linkId: 'h45srcnat1:' + '2'.repeat(64),
        observationId: 'h45natobs1:' + '3'.repeat(64), observationDigest: '4'.repeat(64), inventorySha256: '5'.repeat(64),
        captureRef: {abiObservationId: 'h45abi1:' + '6'.repeat(64), abiObservationDigest: '7'.repeat(64), inputSha256: '8'.repeat(64)},
        profile: {id: selected.id, profileId: selected.provider.profileId, components: selected.components}}};
}

/** Normalize original traces with the production sequence/grouping helpers, independently of inventory expectations. */
function normalizedOutput(input, trace, selected, decisions, nativeEnabled = true) {
    const processed = [], body = trace[1];
    let first = true;
    for (const [, originalAction] of structuredClone(body.action_traces)) {
        const action = normalizeActionSequences(originalAction);
        assert.equal(action.except, null);
        action.global_sequence = action.receipt[1].global_sequence;
        action.receipt = action.receipt[1];
        Object.assign(action, {'@timestamp': input.source.timestamp, block_num: input.source.blockNum,
            block_id: input.source.blockId, producer: input.source.producer, trx_id: body.id});
        delete action.except; if (action.error_code === null) delete action.error_code;
        const fact = input.wireActionInputs.find(value => value.transactionId === body.id && value.actionOrdinal === action.action_ordinal);
        assert(fact);
        action.protocol = {schemaVersion: 1, source: {chainId, blockNum: input.source.blockNum, blockId: input.source.blockId},
            selectionId: input.sourceSelectionId, input: fact};
        const decision = decisions.find(value => value.origin.transactionId === body.id
            && value.origin.actionOrdinal === fact.inputActionOrdinal);
        assert(decision);
        if (nativeEnabled && decision.kind === 'native') {
            action.protocol = nativeLocator(action.protocol, selected, decision.nativeKind);
            action.act.data = selected.provider.nativeActions.decodeValue(decision.nativeKind, Buffer.from(fact.rawHex, 'hex'));
        }
        if (first) {
            action.cpu_usage_us = body.cpu_usage_us;
            if (body.net_usage_words) action.net_usage_words = body.net_usage_words;
            const signatures = body.partial?.[1]?.signatures ?? body.partial?.[1]?.prunable_data?.prunable_data?.[1]?.signatures ?? [];
            if (signatures.length) action.signatures = signatures;
            if (body.action_traces.length > 1) {action.inline_count = body.action_traces.length - 1; action.inline_filtered = false;}
            first = false;
        }
        processed.push(action);
    }
    const documents = groupActionTraces(processed, true);
    for (const document of documents) {
        document.act_digest = document.receipts[0].act_digest;
        for (const receipt of document.receipts) delete receipt.act_digest;
        if (document.context_free === false) delete document.context_free;
    }
    return documents;
}

const directory = mkdtempSync(join(tmpdir(), 'hapi-native-source-inventory-'));
let session;
try {
    const extraction = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
        [join(fixture, 'prepare.py'), join(directory, 'capture')], {encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024});
    assert.equal(extraction.status, 0, extraction.stderr);
    const prepared = JSON.parse(extraction.stdout);
    assert.equal(prepared.files, 1488); assert.equal(prepared.bytes, 27982958); assert.equal(prepared.archiveSha256, archiveSha256);
    const sourceDir = join(directory, 'capture/source'), schemaJson = readFileSync(join(sourceDir, 'schema.json'), 'utf8');
    assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
    const selected = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId});
    assert.equal(selected.provider.profileId, profileId); assert.equal(selected.provider.nativeActions.interfaceVersion, 1);
    assert(selected.components.every(component => component.sourceRevision === wireRevision));
    const legacy = await Promise.all(legacyProfiles.map(profileId => loadChainProtocol(
        {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId})));
    for (const value of legacy) assert.equal(value.provider.nativeActions, undefined);
    session = selected.provider.createShipSession(JSON.parse(schemaJson));
    const accepted = [], controls = [];
    for (const row of oracles) {
        const name = `block-${String(row.blockNum).padStart(6, '0')}.bin`, bytes = readFileSync(join(sourceDir, name));
        assert.deepEqual(bytes, readFileSync(join(original, name)));
        const [, frame] = session.decodeResult(bytes), block = session.decodeBlock(Buffer.from(frame.block, 'hex'));
        assert.equal(frame.this_block.block_id, row.blockId);
        const source = {chainId, blockNum: row.blockNum, blockId: row.blockId, previousBlockId: frame.prev_block.block_id};
        const traces = session.decodeTraces(Buffer.from(frame.traces, 'hex'));
        const facts = selected.provider.observeBlockAbi({traces, accountRows: []}, source);
        assert.deepEqual(facts.actionInputs, deriveProtocolActionInputs(traces));
        const decisions = selected.provider.nativeActions.observe({schemaJson, block: Buffer.from(frame.block, 'hex'),
            traces: Buffer.from(frame.traces, 'hex')}, source).decisions;
        const input = {profileId, source: {chainId, blockNum: row.blockNum, blockId: row.blockId,
            producer: block.producer, timestamp: block.timestamp}, policy, traces, wireActionInputs: facts.actionInputs,
            sourceSelectionId: 'h45srcsel1:' + hash(bytes)};
        const inventory = deriveActionSourceInventory(input);
        assert.equal(inventory.profileId, profileId, 'native inventory must retain its exact selected identity');
        for (const [ordinal, trace] of traces.entries()) {
            const output = normalizedOutput(input, trace, selected, decisions);
            assert.deepEqual(validateActionSourceTransactionOutput(inventory, ordinal, output), output);
            for (const document of output.filter(document => document.protocol.schemaVersion === 2)) {
                assert.equal(document.protocol.native.profile.profileId, profileId);
                assert.deepEqual(document.act.data, row.expectedValue);
                assert.equal(document.protocol.input.rawHex, row.rawHex);
                assert.equal(document.global_sequence, row.globalSequence);
                assert.equal(Buffer.from(selected.provider.nativeActions.encodeValue(row.nativeKind, document.act.data)).toString('hex'), row.rawHex);
                const mutations = [
                    ['foreign-profile', value => {value.protocol.native.profile.profileId = 'foreign-engineering-v1';}],
                    ...legacyProfiles.map(legacyId => ['legacy-native-metadata', value => {value.protocol.native.profile.profileId = legacyId;}]),
                    ['source-block', value => {value.protocol.source.blockId = '0'.repeat(64);}],
                    ['selection', value => {value.protocol.selectionId = 'h45srcsel1:' + '0'.repeat(64);}],
                    ['raw-input', value => {value.protocol.input.rawHex += '00';}],
                    ['global-sequence', value => {value.global_sequence = '18446744073709551615';}],
                    ['receipt-membership', value => {value.receipts[0].receiver = 'foreign';}],
                ];
                for (const [label, mutate] of mutations) {
                    const changed = structuredClone(output); mutate(changed.find(value => value.protocol.schemaVersion === 2));
                    assert.throws(() => validateActionSourceTransactionOutput(inventory, ordinal, changed), ActionSourceInventoryError);
                    controls.push({blockNum: row.blockNum, label});
                }
                const incomplete = structuredClone(output), affected = incomplete.find(value => value.protocol.schemaVersion === 2);
                affected.protocol.status = 'incomplete'; affected.protocol.error = {code: 'source_test', message: 'Explicit codec failure'};
                affected.act.data = affected.protocol.input.rawHex; affected.ds_error = true;
                assert.deepEqual(validateActionSourceTransactionOutput(inventory, ordinal, incomplete), incomplete);
                affected.act.data = row.expectedValue;
                assert.throws(() => validateActionSourceTransactionOutput(inventory, ordinal, incomplete), /exact original raw action/);
            }
            for (const selectedLegacy of legacy) {
                const oldInput = {...input, profileId: selectedLegacy.provider.profileId};
                const oldInventory = deriveActionSourceInventory(oldInput);
                assert.equal(oldInventory.profileId, oldInput.profileId);
                assert.deepEqual(validateActionSourceTransactionOutput(oldInventory, ordinal,
                    normalizedOutput(oldInput, trace, selectedLegacy, decisions, false)), normalizedOutput(oldInput, trace, selectedLegacy, decisions, false));
                assert.throws(() => validateActionSourceTransactionOutput(oldInventory, ordinal, output), /different protocol profile/);
            }
        }
        for (const badId of ['wire-sysio-6508c9e8-native-engineering-v2', 'foreign-engineering-v1', '']) {
            assert.throws(() => deriveActionSourceInventory({...input, profileId: badId}), /Unqualified source inventory profile/);
        }
        assert.throws(() => deriveActionSourceInventory({...input, profileId: 'antelope-default-v1'}), /Antelope source cannot use Wire/);
        const missing = structuredClone(input); missing.wireActionInputs.pop();
        assert.throws(() => deriveActionSourceInventory(missing), /Incomplete Wire source observation/);
        const mismatched = structuredClone(input); mismatched.wireActionInputs[0].globalSequence = '18446744073709551615';
        assert.throws(() => deriveActionSourceInventory(mismatched), /does not match original source occurrence/);
        accepted.push({blockNum: row.blockNum, frameSha256: hash(bytes), inventoryProfileId: inventory.profileId,
            nativeKind: row.nativeKind, globalSequence: row.globalSequence, transactions: inventory.transactions.length});
    }
    const [, genesis] = session.decodeResult(readFileSync(join(sourceDir, 'block-000001.bin')));
    assert.equal(genesis.traces, null);
    assert.throws(() => deriveActionSourceInventory({profileId, policy, traces: genesis.traces,
        source: {chainId, blockNum: 1, blockId: genesis.this_block.block_id, producer: 'sysio', timestamp: '2026-01-01T00:00:00.000'}}),
    /Complete bounded original trace vector is required/);
    console.log(JSON.stringify({passed: true, profileId, wireRevision, sdkRevision, archiveSha256,
        nativeActions: accepted, controls, installedNativeActivation: true, originalArchiveMembers: prepared.files,
        legacyProfilesNativeInactive: true, genesisIncomplete: true, syntheticLocatorIds: true,
        nativeAuthorizationQualification: false, fullWorkerQualification: false}));
} finally {
    session?.close?.();
    rmSync(directory, {recursive: true, force: true});
}
