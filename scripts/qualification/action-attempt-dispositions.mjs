/** #284 typed attempt storage; broker, producer, locators and constructed variants confer no canonical authority. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const wireRevision = '7167659e9c043cb3351074fcacb40200cc57f3a3';
const sdkRevision = '339b5c93d1338968c18ed14254961439dcab16a0';
const archiveSha256 = '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7';
const genesisSha256 = 'bdfdb8832cc573cca61f3e53cfa71219241e008b5c9665626295ea9342c2fb60';
const oracleSha256 = 'f2d022f14e493f2297034dd8e7e1846d1504f19bbf1278afee8cd30a955b9720';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
    const deadline = performance.now() + 10000;
    while (!predicate()) {assert(performance.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 5));}
}

function controlledOwner() {
    const publisher = new EventEmitter(), consumer = new EventEmitter();
    const state = {active: true, writable: true, automaticConfirm: true, calls: []};
    consumer.ack = () => assert.fail('Attempt storage qualification cannot acknowledge a worker delivery');
    publisher.sendToQueue = (queue, payload, options, confirm) => {
        state.calls.push({queue, payload: Buffer.from(payload), options: structuredClone(options), confirm});
        if (state.automaticConfirm) queueMicrotask(() => confirm(null));
        return state.writable;
    };
    const owner = {consumer, publisher, current: () => state.active};
    return {owner, publisher, state, close() {state.active = false; publisher.emit('close');}};
}

function instrumentStores(client, store, instrument, options = {}) {
    const admission = instrument(client, store.index, options), journal = instrument(client, store.journal.index);
    const routes = new Map([[store.index, admission], [store.journal.index, journal]]);
    const routed = new Proxy(client, {get(target, key) {
        if (['create', 'index', 'get'].includes(key)) return (request, transport) => {
            const route = routes.get(request.index);
            assert(route, 'Attempt instrument cannot access a foreign record namespace');
            return route.client[key](request, transport);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
    }});
    return {client: routed, admission: admission.state, journal: journal.state};
}

// Read one exact original member without extracting or deleting anything. The
// installed native-genesis result is a DIFFERENT capture of the same block.
export function readOriginalSourceFrame(archive, blockNum) {
    const frames = {1: {bytes: 3711, sha256: genesisSha256},
        36: {bytes: 181260, sha256: '71976b9284762cd6b8a89817a7866ac74b05856ea7a299635740ab30ccd666b3'}};
    const expected = frames[blockNum]; assert(expected, 'Only pinned original qualification frames may be read');
    assert.equal(sha256(readFileSync(archive)), archiveSha256);
    const name = 'source/block-' + String(blockNum).padStart(6, '0') + '.bin';
    const script = [
        'import sys,tarfile',
        'with tarfile.open(sys.argv[1], "r:gz") as archive:',
        ' rows=[row for row in archive.getmembers() if row.name==sys.argv[2]]',
        ' assert len(rows)==1 and rows[0].isfile() and rows[0].size==int(sys.argv[3])',
        ' payload=archive.extractfile(rows[0]).read(int(sys.argv[3])+1)',
        ' assert len(payload)==int(sys.argv[3])',
        ' sys.stdout.buffer.write(payload)',
    ].join('\n');
    const child = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script, archive, name, String(expected.bytes)],
        {timeout: 20000, maxBuffer: expected.bytes + 64 * 1024, windowsHide: true});
    assert.equal(child.status, 0, child.stderr?.toString());
    assert.equal(child.stdout.length, expected.bytes); assert.equal(sha256(child.stdout), expected.sha256);
    return child.stdout;
}

function configurationWorker(chain, {exclude = false, noEffectsPolicy = false, disableIndexing = false, fetchTraces = true} = {}) {
    const blacklist = exclude ? ['sysio::*'] : noEffectsPolicy ? ['sysio::setabi'] : [], whitelist = noEffectsPolicy ? ['sysio::setabi'] : [];
    return {conf: {settings: {chain, parser: '3.2', eosio_alias: 'sysio',
        protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId}},
        indexer: {disable_indexing: disableIndexing, fetch_traces: fetchTraces, max_inline: 0}, scaling: {ad_idx_queues: 2},
        whitelists: {root_only: false, actions: whitelist, deltas: [], max_depth: 0}, blacklists: {actions: blacklist, deltas: []}},
        filters: {action_blacklist: new Set(blacklist), action_whitelist: new Set(whitelist),
            delta_blacklist: new Set(), delta_whitelist: new Set()}, mLoader: {snapshotActionHandlers: () => []}};
}

/** Deliberately constructed component sources, not accepted chain blocks or observed original workload. */
export function constructAttemptSourceVariant(codec, originalBytes, kind) {
    const frame = codec.decode('result', originalBytes);
    const original = codec.decode('transaction_trace[]', Buffer.from(frame[1].traces, 'hex'));
    assert(original.length > 0 && original[0][1].action_traces.length === 1, 'Base must have one original implicit root');
    let traces = [structuredClone(original[0])];
    if (kind === 'empty-source') traces = [];
    else if (kind === 'empty-transaction') traces[0][1].action_traces = [];
    else if (kind === 'mixed-inline') {
        const inline = structuredClone(traces[0][1].action_traces[0]);
        Object.assign(inline[1], {action_ordinal: 2, creator_action_ordinal: 1, receiver: 'fixture'});
        Object.assign(inline[1].act, {account: 'fixture', name: 'complete', data: '00'});
        const receipt = inline[1].receipt[1];
        Object.assign(receipt, {receiver: 'fixture', act_digest: sha256('constructed-inline-contract-sibling'),
            global_sequence: (BigInt(receipt.global_sequence) + 1n).toString(), recv_sequence: (BigInt(receipt.recv_sequence) + 1n).toString()});
        traces[0][1].action_traces.push(inline);
    } else throw new Error('Unknown constructed attempt source variant');
    frame[1].traces = Buffer.from(codec.encode('transaction_trace[]', traces)).toString('hex');
    return Buffer.from(codec.encode('result', frame));
}

export async function qualifyActionAttemptDispositions({client, chain, targetIndex, check, instrument, report}) {
    const [{ActionSourceAdmissionStore, actionSourceAdmissionHeader}, {actionContractOutputFailure},
        {publishAdmittedActionWithEvidence}, {actionHistoryImmutableJson}, {deriveActionSourceInventory, ActionSourceInventoryError},
        {loadChainProtocol}, {normalizeActionSequences}, {groupActionTraces}, {currentActionConfiguration, currentActionPolicy}, wireCodec] = await Promise.all([
        import('../../build/indexer/history/action-source-admission.js'),
        import('../../build/indexer/history/action-attempt-disposition.js'),
        import('../../build/indexer/history/action-confirmed-publication.js'),
        import('../../build/indexer/history/action-history-manifest.js'),
        import('../../build/indexer/history/action-source-inventory.js'),
        import('../../build/indexer/protocol/selection.js'),
        import('../../build/indexer/helpers/action-sequences.js'),
        import('../../build/indexer/helpers/action-dedup.js'),
        import('../../build/indexer/history/action-producer-epoch.js'), import('@eosrio/hyperion-wire-plugin')]);
    assert(targetIndex.startsWith(chain + '-action-'), 'Attempt target must belong to the owned runner');
    const settings = (await client.indices.getSettings({index: targetIndex, flat_settings: true}))[targetIndex];
    const target = {name: targetIndex, uuid: settings?.settings?.['index.uuid']};
    assert.equal(typeof target.uuid, 'string'); assert(target.uuid.length > 0);
    const wire = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
    const fixture = join(wire, 'fixtures/codec/native-onblock-6508-20261022');
    const receipt = readJson(join(wire, 'dist/protocol-source-receipt.json'));
    assert.equal(receipt.sourceRevision, wireRevision);
    const lock = readJson(new URL('../../package-lock.json', import.meta.url));
    for (const [name, revision] of [['hyperion-wire-plugin', wireRevision], ['hyperion-sdk', sdkRevision]])
        assert.equal(lock.packages[`node_modules/@eosrio/${name}`].resolved, `git+ssh://git@github.com/eosrio/${name}.git#${revision}`);
    const manifest = readJson(join(fixture, 'manifest.json'));
    assert.equal(manifest.originalArchiveSha256, archiveSha256);
    for (const member of manifest.members) {
        const data = readFileSync(join(fixture, member.path));
        assert.equal(data.length, member.bytes); assert.equal(sha256(data), member.sha256);
    }
    const oracleBytes = readFileSync(join(fixture, 'expected.json')); assert.equal(sha256(oracleBytes), oracleSha256);
    const oracle = JSON.parse(oracleBytes).find(value => value.blockNum === 122); assert(oracle);
    const schemaJson = readFileSync(join(fixture, manifest.schema.path), 'utf8');
    assert.equal(sha256(schemaJson), manifest.schema.sha256);
    const sourceArchive = fileURLToPath(new URL('../../tests/fixtures/portable-state-worker/source-1-1480-20261020.tar.gz', import.meta.url));
    const genesisBytes = readOriginalSourceFrame(sourceArchive, 1), contractBytes = readOriginalSourceFrame(sourceArchive, 36);
    const originalBytes = readFileSync(join(fixture, 'block-000122.bin'));
    const selected = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId});
    assert.equal(selected.provider.profileId, profileId); assert(selected.components.every(value => value.sourceRevision === wireRevision));
    const session = selected.provider.createShipSession(JSON.parse(schemaJson)), owners = new Set();
    const codec = wireCodec.createWireValueCodec(JSON.parse(schemaJson), wireCodec.resolveCodecProfile(profileId));
    const owner = () => {const value = controlledOwner(); owners.add(value); return value;};
    const store = new ActionSourceAdmissionStore(client, chain, 1), observedReceipts = [];
    const isAttempt = write => write.request.document?.kind === 'manifest' && write.request.document.bundle_id?.startsWith('h45actionattempt1:');
    async function retain(label, bytes, options = {}) {
        const worker = configurationWorker(chain, options), configuration = currentActionConfiguration(worker);
        const [, frame] = session.decodeResult(bytes), decodedBlock = session.decodeBlock(Buffer.from(frame.block, 'hex'));
        const traces = frame.traces === null ? null : session.decodeTraces(Buffer.from(frame.traces, 'hex'));
        const position = {chainId: manifest.chainId, blockNum: frame.this_block.block_num, blockId: frame.this_block.block_id,
            previousBlockId: frame.prev_block?.block_id ?? null};
        const facts = traces === null ? [] : selected.provider.observeBlockAbi({traces, accountRows: []}, position).actionInputs;
        const inventoryInput = {profileId, source: {chainId: position.chainId, blockNum: position.blockNum, blockId: position.blockId,
            producer: decodedBlock.producer, timestamp: decodedBlock.timestamp}, policy: currentActionPolicy(worker), traces,
            wireActionInputs: facts, sourceSelectionId: 'h45srcsel1:' + sha256(bytes)};
        const captureSha256 = sha256(bytes);
        const ingressId = await store.retainIngress({schemaVersion: 1, chainId: position.chainId, protocolId: selected.id,
            profileId, components: selected.components, readerSessionId: 'constructed-attempt-component-reader',
            schemaJson, frameHex: bytes.toString('hex'), captureSha256});
        const sourceId = await store.retainSource({schemaVersion: 1, frameHex: bytes.toString('hex'), schemaJson,
            captureSha256, ingressId, previousBlockId: position.previousBlockId,
            producer: {protocolId: selected.id, profileId, codeRevision: report.source.gitHead,
                configurationSha256: sha256(configuration), pluginsSha256: sha256('constructed-attempt-producer:' + label)},
            executableSha256: sha256('constructed-attempt-executable:' + report.source.gitHead), inventoryInput});
        const admission = await store.admit(sourceId, options.target ?? target);
        return {admission, configuration, worker, bytes, frame, traces, position, inventoryInput, ingressId};
    }
    const sourceInput = (work, owned) => ({admissionId: work.admission.id, configuration: work.configuration, owner: owned.owner});
    const record = (writer, owned, evidence, signal) => writer.recordAttemptDisposition({owner: owned.owner, evidence}, signal);
    const trackedStore = options => {
        const tracked = instrumentStores(client, store, instrument, options);
        return {tracked, writer: new ActionSourceAdmissionStore(tracked.client, chain, 1)};
    };
    const transactionInput = (work, owned, traceOrdinal = 0) => {
        const transaction = work.admission.inventory?.transactions.find(value => value.traceOrdinal === traceOrdinal);
        assert(transaction?.dispatch, 'A transaction issuer requires its original matching dispatch');
        return {...sourceInput(work, owned), traceOrdinal, dispatchPayload: Buffer.from(transaction.dispatch.canonicalJson)};
    };
    function documents(work, {rawFirst = false} = {}) {
        const transaction = work.traces[0][1], processed = [];
        const decisions = selected.provider.nativeActions.observe({schemaJson, block: Buffer.from(work.frame.block, 'hex'),
            traces: Buffer.from(work.frame.traces, 'hex')}, work.position).decisions;
        for (const [, original] of structuredClone(transaction.action_traces)) {
            const action = normalizeActionSequences(original), first = processed.length === 0;
            action.global_sequence = action.receipt[1].global_sequence; action.receipt = action.receipt[1];
            Object.assign(action, {'@timestamp': work.inventoryInput.source.timestamp, block_num: work.position.blockNum,
                block_id: work.position.blockId, producer: work.inventoryInput.source.producer, trx_id: transaction.id});
            delete action.except; if (action.error_code === null) delete action.error_code;
            const input = work.inventoryInput.wireActionInputs.find(value => value.transactionId === transaction.id && value.actionOrdinal === action.action_ordinal);
            assert(input, 'Every constructed output keeps independently observed source membership');
            const decision = decisions.find(value => value.origin.transactionId === transaction.id && value.origin.actionOrdinal === input.inputActionOrdinal);
            assert(decision && ['native', 'contract'].includes(decision.kind));
            const source = {chainId: work.position.chainId, blockNum: work.position.blockNum, blockId: work.position.blockId};
            action.protocol = {schemaVersion: 1, source, selectionId: work.inventoryInput.sourceSelectionId, input};
            if (decision.kind === 'native') {
                // Shape-valid locators only. This component does not obtain canonical/native proof grants.
                action.protocol = {...action.protocol, schemaVersion: 2, kind: 'native', native: {
                    nativeKind: decision.nativeKind, contextId: 'h45srcctx1:' + '1'.repeat(64), linkId: 'h45srcnat1:' + '2'.repeat(64),
                    observationId: 'h45natobs1:' + '3'.repeat(64), observationDigest: '4'.repeat(64), inventorySha256: '5'.repeat(64),
                    captureRef: {abiObservationId: 'h45abi1:' + '6'.repeat(64), abiObservationDigest: '7'.repeat(64), inputSha256: '8'.repeat(64)},
                    profile: {id: selected.id, profileId, components: selected.components}}};
                action.act.data = selected.provider.nativeActions.decodeValue(decision.nativeKind, Buffer.from(input.rawHex, 'hex'));
                assert.deepEqual(action.act.data, oracle.expectedValue); assert.equal(input.rawHex, oracle.rawHex);
                if (first && rawFirst) {
                    action.act.data = input.rawHex; action.ds_error = true;
                    action.protocol = {...action.protocol, status: 'incomplete',
                        error: {code: 'native_output_incomplete', message: 'Controlled component raw fallback; no canonical authority'}};
                }
            } else {
                // The normal provider classifies this deliberately constructed inline sibling as contract work.
                // No ABI value decode is claimed for it; portable values remain opaque to this storage component.
                action.act.data = {constructed_component_contract_sibling: true};
            }
            if (first) {
                action.cpu_usage_us = transaction.cpu_usage_us;
                if (transaction.net_usage_words) action.net_usage_words = transaction.net_usage_words;
                const signatures = transaction.partial?.[1]?.signatures ?? transaction.partial?.[1]?.prunable_data?.prunable_data?.[1]?.signatures ?? [];
                if (signatures.length) action.signatures = signatures;
                if (transaction.action_traces.length > 1) {action.inline_count = transaction.action_traces.length - 1; action.inline_filtered = false;}
            }
            processed.push(action);
        }
        const grouped = groupActionTraces(processed, true);
        for (const document of grouped) {
            document.act_digest = document.receipts[0].act_digest;
            for (const receipt of document.receipts) delete receipt.act_digest;
            if (document.context_free === false) delete document.context_free;
        }
        return grouped;
    }
    async function publicationInput(work, owned, output, {route = 1, headers: changedHeaders} = {}) {
        const input = transactionInput(work, owned);
        const prepared = await store.prepareTransaction(work.admission, input.traceOrdinal, input.dispatchPayload, output);
        const headers = changedHeaders ?? {block_num: work.position.blockNum, [actionSourceAdmissionHeader]: work.admission.id,
            action_fragment_id: prepared.fragmentId};
        const publications = [];
        for (const document of output) publications.push(await publishAdmittedActionWithEvidence(owned.owner,
            `${chain}:index_actions:${route}`, Buffer.from(actionHistoryImmutableJson(document)), {headers}));
        assert(owned.state.calls.every(value => value.options.mandatory === true && value.options.persistent === true));
        return {...input, publications};
    }
    async function durableObservation(context, owned, evidence) {
        const stored = await record(context.writer, owned, evidence);
        assert.match(stored.id, /^h45actionattempt1:[0-9a-f]{64}$/);
        assert.equal(stored.observation.kind, 'action-attempt-disposition');
        assert(context.tracked.admission.durableReceipts.some(value => value.id === stored.id && value.successful === 2 && value.failed === 0));
        const observer = trackedStore();
        assert.deepEqual(await observer.writer.readAttemptDisposition(stored.id), stored);
        assert.equal(observer.tracked.admission.writes.length, 0); assert.equal(observer.tracked.journal.writes.length, 0);
        observedReceipts.push(...context.tracked.admission.durableReceipts.slice(context.receiptCursor ?? 0));
        context.receiptCursor = context.tracked.admission.durableReceipts.length;
        return stored;
    }
    try {
        await check('original missing-trace genesis retains a two-copy source-scoped unresolved attempt', async () => {
            const work = await retain('original-genesis', genesisBytes), owned = owner(), {tracked, writer} = trackedStore();
            assert.equal(work.frame.this_block.block_num, 1); assert.equal(work.traces, null);
            assert.equal(work.admission.planId, null); assert.equal(work.admission.inventory, undefined);
            const evidence = await writer.prepareSourceAttemptDispositions(sourceInput(work, owned));
            assert.equal(evidence.length, 1); assert(Object.isFrozen(evidence[0]));
            const stored = await record(writer, owned, evidence[0]), observation = stored.observation;
            assert.match(stored.id, /^h45actionattempt1:[0-9a-f]{64}$/);
            assert.equal(observation.kind, 'action-attempt-disposition'); assert.equal(observation.disposition, 'source-unprocessable');
            assert(['source-traces-missing', 'source-predecessor-missing'].includes(observation.reason));
            assert.equal(observation.work.stage, 'main-source'); assert.equal(observation.work.planId, null);
            assert.equal(observation.work.transaction, null); assert.equal(observation.work.admissionId, work.admission.id);
            assert.equal(observation.work.sourceId, work.admission.sourceId); assert.equal(observation.work.ingressId, work.ingressId);
            assert.equal(observation.work.source.captureSha256, genesisSha256); assert.deepEqual(observation.work.target, target);
            assert.deepEqual(observation.output, {kind: 'unresolved'});
            assert.deepEqual(await new ActionSourceAdmissionStore(client, chain, 1).readAttemptDisposition(stored.id), stored);
            assert(tracked.admission.durableReceipts.some(value => value.id === stored.id && value.successful === 2 && value.failed === 0));
            assert.equal(tracked.journal.writes.length, 0, 'Missing original traces cannot fabricate a plan or fragment');
            assert(tracked.admission.writes.every(write => !write.request.id.startsWith('h45actionhandoff1:')));
            observedReceipts.push(...tracked.admission.durableReceipts);
            return {originalBlock: 1, originalFrameSha256: genesisSha256, absentTracesRetained: true,
                storedReason: observation.reason, inventedPlanOrOrdinal: false, actualCopies: 2, actualMainDsAck: false};
        });
        await check('complete original source plus captured exclusion policy records no required effects', async () => {
            const work = await retain('policy-excluded', originalBytes, {exclude: true}), owned = owner(), context = trackedStore();
            assert(work.traces.length > 0); assert(work.traces[0][1].action_traces.length > 0);
            const inventory = deriveActionSourceInventory(work.inventoryInput);
            assert.deepEqual(work.admission.inventory, inventory);
            assert(inventory.transactions.every(value => value.disposition === 'excluded' && value.groups.length === 0));
            const evidence = await context.writer.prepareSourceAttemptDispositions(sourceInput(work, owned));
            assert.equal(evidence.length, inventory.transactions.length);
            for (let index = 0; index < evidence.length; index++) {
                const {observation} = await durableObservation(context, owned, evidence[index]);
                assert.equal(observation.disposition, 'policy-excluded'); assert.equal(observation.reason, 'policy-excluded');
                assert.equal(observation.work.stage, 'main-source'); assert.equal(observation.work.policySha256, inventory.policySha256);
                assert.equal(observation.work.transaction.traceOrdinal, inventory.transactions[index].traceOrdinal);
                assert.equal(observation.work.transaction.expectedGroups, 0); assert.deepEqual(observation.output, {kind: 'none-required'});
            }
            assert.equal(owned.state.calls.length, 0);
            return {originalBlock: 122, originalSourceBytesUnchanged: true, constructedOperatorPolicy: true,
                disabledIndexing: false, actualCopies: 2, actualWorkerAck: false};
        });

        for (const variant of ['empty-source', 'empty-transaction']) {
            await check(`constructed ${variant} preserves its distinct complete membership scope`, async () => {
                const bytes = constructAttemptSourceVariant(codec, originalBytes, variant);
                const work = await retain(variant, bytes), owned = owner(), context = trackedStore();
                assert.equal(work.traces.length, variant === 'empty-source' ? 0 : 1);
                assert.equal(work.admission.incomplete, null); assert(work.admission.planId);
                const evidence = await context.writer.prepareSourceAttemptDispositions(sourceInput(work, owned)); assert.equal(evidence.length, 1);
                const {observation} = await durableObservation(context, owned, evidence[0]);
                assert.equal(observation.disposition, 'no-effects'); assert.equal(observation.work.stage, 'main-source');
                assert.equal(observation.work.planId, work.admission.planId); assert.deepEqual(observation.output, {kind: 'none-required'});
                if (variant === 'empty-source') {
                    assert.equal(observation.reason, 'empty-source-vector'); assert.equal(observation.work.transaction, null);
                    assert.equal(work.admission.inventory.transactions.length, 0);
                } else {
                    assert.equal(observation.reason, 'no-effects'); assert.equal(observation.work.transaction.traceOrdinal, 0);
                    assert.equal(observation.work.transaction.dispatchSha256, null); assert.equal(observation.work.transaction.expectedGroups, 0);
                    assert.equal(work.admission.inventory.transactions[0].dispatch, null);
                }
                assert.equal(owned.state.calls.length, 0);
                return {constructedSource: true, variant, encodedFrameSha256: sha256(bytes), actualCopies: 2,
                    originalCorpusNoEffectClaim: false, canonicalAuthority: false, actualWorkerAck: false};
            });
        }

        await check('original36 with constructed intersecting filters retains no-effects dispatch at the DS stage', async () => {
            const work = await retain('no-effects-with-dispatch', contractBytes, {noEffectsPolicy: true}), owned = owner(), context = trackedStore();
            assert.equal(sha256(work.bytes), '71976b9284762cd6b8a89817a7866ac74b05856ea7a299635740ab30ccd666b3');
            const inventory = deriveActionSourceInventory(work.inventoryInput); assert.deepEqual(work.admission.inventory, inventory);
            const transaction = inventory.transactions.find(value => value.traceOrdinal === 1);
            assert.equal(transaction.transactionId, '140abb3d398f206518e117c02ccf1f1604b37b9fb55f7abed2034cf2fb374c66');
            assert.equal(transaction.disposition, 'no-effects'); assert(transaction.dispatch); assert.equal(transaction.groups.length, 0);
            const sourceEvidence = await context.writer.prepareSourceAttemptDispositions(sourceInput(work, owned));
            assert.equal(sourceEvidence.length, 1, 'Main source records only excluded tx0, never invents a finished DS attempt');
            const sourceRecord = await durableObservation(context, owned, sourceEvidence[0]);
            assert.equal(sourceRecord.observation.disposition, 'policy-excluded'); assert.equal(sourceRecord.observation.work.transaction.traceOrdinal, 0);
            const evidence = await context.writer.prepareTransactionAttemptDisposition(transactionInput(work, owned, 1)); assert(evidence);
            const {observation} = await durableObservation(context, owned, evidence);
            assert.equal(observation.disposition, 'no-effects'); assert.equal(observation.reason, 'no-effects');
            assert.equal(observation.work.stage, 'ds-transaction'); assert.equal(observation.work.transaction.traceOrdinal, 1);
            assert.equal(observation.work.transaction.dispatchSha256, transaction.dispatch.bodySha256);
            assert.equal(observation.work.transaction.expectedGroups, 0); assert.deepEqual(observation.output, {kind: 'none-required'});
            assert.equal(owned.state.calls.length, 0);
            return {originalBlock: 36, originalSourceBytesUnchanged: true, constructedOperatorPolicy: true,
                originalActionSequences: ['45', '46'], noNormalPolicyNoEffectClaim: true, dsAttemptDistinctFromSource: true, actualCopies: 2};
        });

        for (const mode of ['traces-disabled', 'indexing-disabled']) {
            await check(`captured ${mode} remains separate from exclusion and preserves expected process groups`, async () => {
                const work = await retain(mode, originalBytes, {fetchTraces: mode !== 'traces-disabled', disableIndexing: mode === 'indexing-disabled'});
                const owned = owner(), context = trackedStore(), transaction = work.admission.inventory.transactions[0];
                assert.equal(transaction.disposition, 'process'); assert(transaction.dispatch); assert(transaction.groups.length > 0);
                const sourceEvidence = await context.writer.prepareSourceAttemptDispositions(sourceInput(work, owned));
                let evidence;
                if (mode === 'traces-disabled') {assert.equal(sourceEvidence.length, 1); [evidence] = sourceEvidence;}
                else {assert.equal(sourceEvidence.length, 0); evidence = await context.writer.prepareTransactionAttemptDisposition(transactionInput(work, owned));}
                assert(evidence); const {observation} = await durableObservation(context, owned, evidence);
                assert.equal(observation.disposition, 'operator-disabled'); assert.equal(observation.reason, mode);
                assert.equal(observation.work.stage, mode === 'traces-disabled' ? 'main-source' : 'ds-transaction');
                assert.equal(observation.work.planId, work.admission.planId);
                assert.equal(observation.work.transaction.expectedGroups, transaction.groups.length);
                assert.equal(observation.work.transaction.dispatchSha256, transaction.dispatch.bodySha256);
                assert.deepEqual(observation.output, {kind: 'unresolved'}); assert.equal(owned.state.calls.length, 0);
                return {mode, originalBlock: 122, constructedOperatorConfiguration: true,
                    expectedGroupsRetained: transaction.groups.length, policyExclusionOrNoEffects: false, actualCopies: 2, actualWorkerAck: false};
            });
        }

        await check('complete ordinary processing stays eligible only for the existing successful-handoff path', async () => {
            const work = await retain('ordinary-complete', originalBytes), owned = owner();
            assert.deepEqual(await store.prepareSourceAttemptDispositions(sourceInput(work, owned)), []);
            assert.equal(await store.prepareTransactionAttemptDisposition(transactionInput(work, owned)), undefined);
            return {typedSkippedObservationIssued: false, existingSuccessPathUnchanged: true, actualWorkerAck: false};
        });

        await check('bound pure contract-output gap retains expected groups and can coexist with later success', async () => {
            const bytes = constructAttemptSourceVariant(codec, originalBytes, 'mixed-inline');
            const work = await retain('contract-gap-coexistence', bytes), owned = owner(), context = trackedStore();
            const binding = transactionInput(work, owned);
            assert.equal(work.admission.inventory.transactions[0].groups.length, 2);
            // A known pure portability check, not a generic caught async hook/I/O error.
            assert.throws(() => actionHistoryImmutableJson({constructed_nonportable_value: 1n}));
            const failure = actionContractOutputFailure(binding, 'contract-output-not-portable', 'Controlled nonportable component output');
            const evidence = await context.writer.prepareContractAttemptDisposition({...binding, failure});
            const stored = await durableObservation(context, owned, evidence);
            assert.equal(stored.observation.disposition, 'contract-output-incomplete');
            assert.equal(stored.observation.reason, 'contract-output-not-portable'); assert.equal(stored.observation.work.stage, 'ds-transaction');
            assert.equal(stored.observation.work.transaction.expectedGroups, 2); assert.deepEqual(stored.observation.output, {kind: 'unresolved'});
            assert.equal(context.tracked.journal.writes.length, 0, 'No-output gap cannot invent a fragment or seal');
            assert.equal(owned.state.calls.length, 0);
            const complete = documents(work), successful = await store.recordConfirmedHandoff(await publicationInput(work, owned, complete));
            assert.equal(successful.outcome.effects.length, 2);
            assert.deepEqual(await store.readAttemptDisposition(stored.id), stored, 'Later success cannot erase the earlier gap');
            assert.deepEqual(await store.readConfirmedHandoff(work.admission.id, 0, binding.dispatchPayload), successful);
            return {constructedSource: true, knownPurePortabilityControl: true, expectedGroupsRetained: 2,
                independentRecordNamespacesCoexist: true, constructedContractSiblingValue: true,
                canonicalAuthority: false, actualCopies: 2, actualWorkerAck: false};
        });

        await check('mixed raw-incomplete handoff requires confirmation and original drain for every expected group', async () => {
            const bytes = constructAttemptSourceVariant(codec, originalBytes, 'mixed-inline');
            const work = await retain('mixed-raw-confirmation', bytes), owned = owner(), context = trackedStore(), output = documents(work, {rawFirst: true});
            assert.equal(output.length, 2); assert.equal(output[0].protocol.status, 'incomplete'); assert.equal(output[1].protocol.status, undefined);
            owned.state.writable = false; owned.state.automaticConfirm = false;
            let returned = false, publicationError;
            const pending = publicationInput(work, owned, output).then(value => {returned = true; return value;}); pending.catch(error => {publicationError = error;});
            await until(() => {if (publicationError) throw publicationError; return owned.state.calls.length === 1;}, 'Actual first group reaches its controlled publisher');
            assert.equal(returned, false);
            owned.state.calls[0].confirm(null); await tick(); assert.equal(returned, false);
            owned.state.writable = true; owned.state.automaticConfirm = true; owned.publisher.emit('drain');
            const input = await pending; assert.equal(owned.state.calls.length, 2);
            await assert.rejects(context.writer.prepareRawIncompleteAttemptDisposition({...input, publications: input.publications.slice(0, 1)}));
            const evidence = await context.writer.prepareRawIncompleteAttemptDisposition(input);
            const stored = await durableObservation(context, owned, evidence), observation = stored.observation;
            assert.equal(observation.disposition, 'raw-incomplete-handoff'); assert.equal(observation.reason, 'raw-output-incomplete');
            assert.equal(observation.work.transaction.expectedGroups, 2); assert.equal(observation.output.kind, 'raw-incomplete');
            assert.deepEqual(observation.output.effects.map(value => value.status), ['incomplete', 'complete']);
            for (let index = 0; index < 2; index++) {
                assert.equal(observation.output.effects[index].payloadSha256, sha256(owned.state.calls[index].payload));
                assert.equal(observation.output.effects[index].headersSha256, sha256(actionHistoryImmutableJson(owned.state.calls[index].options.headers)));
            }
            await assert.rejects(store.recordConfirmedHandoff(input), /Incomplete|incomplete/);
            await assert.rejects(store.readConfirmedHandoff(work.admission.id, 0, input.dispatchPayload));
            const retriedInput = await publicationInput(work, owned, output, {route: 2});
            const retry = await durableObservation(context, owned, await context.writer.prepareRawIncompleteAttemptDisposition(retriedInput));
            assert.deepEqual(retry, stored); assert.notEqual(owned.state.calls[0].options.messageId, owned.state.calls[2].options.messageId);
            assert(context.tracked.admission.writes.some(write => write.method === 'index' && write.request.id === stored.id));
            return {constructedSource: true, normalProviderDecisions: ['native', 'contract'], completeGroupConfirmed: 2,
                statuses: ['incomplete', 'complete'], controlledBroker: true, actualRabbit: false,
                actualCopies: 2, constructedNativeLocatorsAndContractValue: true, successfulAggregateIssued: false};
        });

        await check('all-complete and schema1 incomplete outputs cannot become raw-incomplete dispositions', async () => {
            const work = await retain('complete-raw-refusal', originalBytes), owned = owner();
            const complete = documents(work), input = await publicationInput(work, owned, complete);
            await assert.rejects(store.prepareRawIncompleteAttemptDisposition(input));
            const mixedWork = await retain('schema1-incomplete-refusal', constructAttemptSourceVariant(codec, originalBytes, 'mixed-inline'));
            const mixed = documents(mixedWork), invalid = structuredClone(mixed);
            invalid[1].ds_error = true; invalid[1].protocol = {...invalid[1].protocol, status: 'incomplete',
                error: {code: 'constructed_contract_unavailable', message: 'Controlled schema1 incomplete output'}};
            const current = owner(), before = current.state.calls.length, binding = transactionInput(mixedWork, current);
            await assert.rejects(store.prepareTransaction(mixedWork.admission, binding.traceOrdinal, binding.dispatchPayload, invalid));
            assert.equal(current.state.calls.length, before, 'Whole-transaction validation rejects schema1 incompleteness before any publication');
            for (const failure of [new Error('arbitrary async storage/hook error'), new ActionSourceInventoryError('generic constructor is not trusted branch provenance'),
                Object.assign(new Error('proof unavailable'), {statusCode: 503})])
                await assert.rejects(store.prepareContractAttemptDisposition({...binding, failure}));
            assert.throws(() => actionContractOutputFailure(binding, 'contract-hook-failed', 'Async hook rejection is not a typed contract reason'));
            return {allCompleteNotRaw: true, schema1IncompleteWholeGroupRefusedBeforePublication: true,
                genericFailureNotKnownContractReason: true, controlledOutputs: true, actualWorkerAck: false};
        });

        for (const mode of ['before-write', 'lost-receipt', 'partial-receipt']) {
            await check(`controlled ${mode} cannot promote an observed attempt without fresh complete-copy repair`, async () => {
                const work = await retain('attempt-write-' + mode, originalBytes, {exclude: true}), owned = owner(); let injected = false;
                const context = trackedStore({
                    beforeWrite(write) {if (mode === 'before-write' && !injected && isAttempt(write)) {
                        injected = true; throw new Error('Controlled attempt manifest refusal before write');
                    }},
                    afterWrite(write, response) {
                        if (!injected && isAttempt(write)) {
                            injected = true;
                            if (mode === 'lost-receipt') throw new Error('Controlled lost attempt receipt after actual complete-copy write');
                            if (mode === 'partial-receipt') return {...response, _shards: {...response._shards, total: 2, successful: 1, failed: 1}};
                        }
                        return response;
                    }});
                const [evidence] = await context.writer.prepareSourceAttemptDispositions(sourceInput(work, owned)); assert(evidence);
                await assert.rejects(record(context.writer, owned, evidence), /Controlled|receipt|durab|cop/i); assert(injected);
                const writes = context.tracked.admission.writes.filter(isAttempt); assert(writes.length > 0);
                const id = writes[0].request.id, observer = trackedStore(); let seen;
                if (mode === 'before-write') await assert.rejects(observer.writer.readAttemptDisposition(id));
                else seen = await observer.writer.readAttemptDisposition(id);
                assert.equal(observer.tracked.admission.writes.length, 0); assert.equal(observer.tracked.journal.writes.length, 0);
                // A restarted store must prepare a new store/owner-bound capability. Reading is insufficient.
                const repair = trackedStore(), [fresh] = await repair.writer.prepareSourceAttemptDispositions(sourceInput(work, owned)); assert(fresh);
                const restored = await durableObservation(repair, owned, fresh);
                assert.equal(restored.id, id); if (seen) assert.deepEqual(restored, seen);
                if (mode !== 'before-write') assert(repair.tracked.admission.writes.some(write => write.method === 'index' && write.request.id === id));
                return {mode, faultBoundary: mode === 'before-write' ? 'Controlled pre-manifest failure' : 'Controlled returned-response fault after real complete-copy write',
                    primaryVisibleBytesAreFreshReceipt: false, freshPreparationAndRepairRequired: true, actualCopies: 2,
                    actualReplicaOutage: false, actualWorkerAck: false};
            });
        }

        await check('observed, serialized, foreign-store and wrong-owner values cannot become a newly issued attempt', async () => {
            const work = await retain('opaque-attempts', originalBytes, {exclude: true}), owned = owner(), context = trackedStore();
            const [evidence] = await context.writer.prepareSourceAttemptDispositions(sourceInput(work, owned)); assert(evidence);
            for (const invalid of [{}, structuredClone(evidence), JSON.parse(JSON.stringify(evidence))])
                await assert.rejects(record(context.writer, owned, invalid));
            const otherOwner = owner(); await assert.rejects(record(context.writer, otherOwner, evidence));
            await assert.rejects(record(new ActionSourceAdmissionStore(client, chain, 1), owned, evidence));
            assert.equal(context.tracked.admission.writes.filter(isAttempt).length, 0);
            const stored = await durableObservation(context, owned, evidence), before = context.tracked.admission.writes.length;
            for (const invalid of [stored, stored.observation, JSON.parse(JSON.stringify(stored.observation))])
                await assert.rejects(record(context.writer, owned, invalid));
            assert.equal(context.tracked.admission.writes.length, before);
            return {opaqueEvidenceRequired: true, serializedReadIssuesNoCapability: true, foreignStoreAndOwnerRefused: true,
                currentOrPermanentDispositionSelected: false, capacityOrReadinessIssued: false, actualCopies: 2};
        });

        await check('bound contract evidence refuses changed configuration, source, physical-target association and fault clones', async () => {
            const work = await retain('contract-binding', originalBytes), owned = owner(), binding = transactionInput(work, owned);
            const failure = actionContractOutputFailure(binding, 'contract-output-not-portable', 'Controlled known pure branch');
            const foreign = await retain('contract-binding-foreign-source', originalBytes);
            const foreignTarget = await retain('contract-binding', originalBytes, {target: {...target, uuid: target.uuid + '-foreign'}});
            const context = trackedStore();
            for (const invalid of [{...binding, configuration: '{}', failure}, {...transactionInput(foreign, owned), failure},
                {...transactionInput(foreignTarget, owned), failure}, {...binding, failure: structuredClone(failure)},
                {...binding, failure: JSON.parse(JSON.stringify(failure))}])
                await assert.rejects(context.writer.prepareContractAttemptDisposition(invalid));
            await assert.rejects(context.writer.prepareSourceAttemptDispositions({...sourceInput(work, owned), configuration: '{}'}));
            assert.equal(context.tracked.admission.writes.filter(isAttempt).length, 0);
            const first = await durableObservation(context, owned, await context.writer.prepareContractAttemptDisposition({...binding, failure}));
            const secondFailure = actionContractOutputFailure(binding, 'contract-output-not-portable', 'Different free diagnostic text is not semantic work identity');
            const second = await durableObservation(context, owned, await context.writer.prepareContractAttemptDisposition({...binding, failure: secondFailure}));
            assert.deepEqual(second, first);
            return {exactBindingChecked: true, actualTargetUuidObserved: true, foreignTargetBindingRefused: true,
                freeDiagnosticNotIdentity: true, constructedFailureAndProducer: true, freshPhysicalTargetOrCanonicalGrant: false, actualCopies: 2};
        });

        await check('raw evidence refuses foreign admission, wrong fragment and changed immutable effect bytes', async () => {
            const bytes = constructAttemptSourceVariant(codec, originalBytes, 'mixed-inline');
            const work = await retain('raw-negatives', bytes), owned = owner(), context = trackedStore(), output = documents(work, {rawFirst: true});
            const input = await publicationInput(work, owned, output);
            const foreign = await retain('raw-negatives-foreign', bytes);
            await assert.rejects(context.writer.prepareRawIncompleteAttemptDisposition({...input, admissionId: foreign.admission.id}));
            const forged = input.publications.map(value => structuredClone(value));
            await assert.rejects(context.writer.prepareRawIncompleteAttemptDisposition({...input, publications: forged}));
            const badHeaders = await publicationInput(work, owned, output, {headers: {block_num: work.position.blockNum,
                [actionSourceAdmissionHeader]: work.admission.id, action_fragment_id: 'h45actionfragment1:' + '0'.repeat(64)}});
            await assert.rejects(context.writer.prepareRawIncompleteAttemptDisposition(badHeaders));
            const stored = await durableObservation(context, owned, await context.writer.prepareRawIncompleteAttemptDisposition(input));
            const changed = structuredClone(output); changed[0].controlled_conflicting_output = true;
            // The prepared membership fragment is also immutable; a new attempt ID cannot evade that conflict.
            await assert.rejects(publicationInput(work, owned, changed), /conflict|different|mismatch/i);
            assert.deepEqual(await store.readAttemptDisposition(stored.id), stored);
            return {forgedAndForeignRawEvidenceRefused: true, originalFragmentHeadersRequired: true,
                immutableOriginalOutputPreserved: true, outputConflictCannotMintAlternateSemanticId: true,
                constructedSourceAndLocators: true, actualCopies: 2};
        });

        for (const mode of ['owner-stale', 'consumer-replaced', 'cancelled']) {
            await check(`controlled ${mode} after an actual attempt write cannot return fresh success`, async () => {
                const work = await retain('attempt-final-' + mode, originalBytes, {exclude: true}), owned = owner();
                const controller = new AbortController(); let injected = false;
                const context = trackedStore({afterWrite(write, response) {
                    if (!injected && isAttempt(write)) {
                        injected = true;
                        if (mode === 'owner-stale') owned.state.active = false;
                        else if (mode === 'consumer-replaced') owned.owner.consumer = new EventEmitter();
                        else controller.abort(new Error('Controlled attempt cancellation after actual write'));
                    }
                    return response;
                }});
                const [evidence] = await context.writer.prepareSourceAttemptDispositions(sourceInput(work, owned)); assert(evidence);
                await assert.rejects(record(context.writer, owned, evidence, controller.signal)); assert(injected);
                const write = context.tracked.admission.writes.find(isAttempt); assert(write);
                const observed = await store.readAttemptDisposition(write.request.id);
                assert.equal(observed.observation.disposition, 'policy-excluded');
                assert(context.tracked.admission.durableReceipts.some(value => value.id === write.request.id && value.successful === 2 && value.failed === 0));
                return {mode, faultBoundary: 'Controlled owner/signal change after actual complete-copy response',
                    observedRecordPromotesFailedCall: false, actualSocketCancellation: false, actualCopies: 2,
                    physicalOrCanonicalRevalidation: false, actualWorkerAck: false};
            });
        }

        report.observations.actionAttemptDispositions = {index: store.index, target, profileId, wireRevision, sdkRevision,
            originalArchiveSha256: archiveSha256, originalGenesisSha256: genesisSha256, originalContractSha256: sha256(contractBytes), oracleSha256,
            sourceReceiptSha256: sha256(readFileSync(join(wire, 'dist/protocol-source-receipt.json'))),
            constructedFrameSha256: Object.fromEntries(['empty-source', 'empty-transaction', 'mixed-inline'].map(kind => [kind, sha256(constructAttemptSourceVariant(codec, originalBytes, kind))])),
            observedDurableReceipts: observedReceipts.length, everyObservedReceiptComplete: observedReceipts.every(value => value.successful === 2 && value.failed === 0),
            constructedProducerAndLocatorBindings: true, constructedContractSiblingValue: true, actualInstalledNativeCodec: true,
            constructedOperatorPolicyForOriginal36: true, noNormalPolicyNoEffectQualification: true, controlledBroker: true, actualWorkerAck: false,
            canonicalAuthorization: false, physicalSinkReadiness: false, authenticatedSettlement: false,
            capacityProtection: false, fullWorkerQualification: false};
        report.qualification.actionAttemptDispositions = true;
    } finally {
        for (const owned of owners) owned.close();
        session.close?.();
    }
}
