/** #282 real-ES outcome storage; broker behavior and native locators are controlled component fixtures. */
import assert from 'node:assert/strict';
import {isPinnedGitSource} from '../../tests/unit/pinned-git-source.mjs';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const legacyWireRevision = '7167659e9c043cb3351074fcacb40200cc57f3a3';
const legacySdkRevision = '339b5c93d1338968c18ed14254961439dcab16a0';
const archiveSha256 = '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7';
const oracleSha256 = 'f2d022f14e493f2297034dd8e7e1846d1504f19bbf1278afee8cd30a955b9720';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));

function controlledOwner() {
    const publisher = new EventEmitter(), consumer = new EventEmitter();
    const state = {active: true, writable: true, automaticConfirm: true, calls: []};
    consumer.ack = () => assert.fail('This storage component must not acknowledge a DS delivery');
    publisher.sendToQueue = (queue, payload, options, confirm) => {
        state.calls.push({queue, payload: Buffer.from(payload), options: structuredClone(options), confirm});
        if (state.automaticConfirm) queueMicrotask(() => confirm(null));
        return state.writable;
    };
    const owner = {consumer, publisher, current: () => state.active};
    return {owner, publisher, state, close() {state.active = false; publisher.emit('close');}};
}

// Keep the existing runner's real receipt checks, allowing only the two exact
// namespaces touched by admission plus its membership journal.
function instrumentStores(client, store, instrument, options = {}) {
    const admission = instrument(client, store.index, options);
    const journal = instrument(client, store.journal.index);
    const routes = new Map([[store.index, admission], [store.journal.index, journal]]);
    const routed = new Proxy(client, {get(target, key) {
        if (['create', 'index', 'get'].includes(key)) return (request, transport) => {
            const route = routes.get(request.index);
            assert(route, 'Outcome instrument cannot access a foreign record namespace');
            return route.client[key](request, transport);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
    }});
    return {client: routed, admission: admission.state, journal: journal.state};
}

/** Construct normalized documents from original trace membership and the installed codec.
 * Locator IDs deliberately grant no native/canonical authority in this storage component. */
function groupedOutput(input, trace, selected, decisions, normalize, group) {
    const processed = [], body = trace[1];
    let first = true;
    for (const [, original] of structuredClone(body.action_traces)) {
        const action = normalize(original);
        action.global_sequence = action.receipt[1].global_sequence;
        action.receipt = action.receipt[1];
        Object.assign(action, {'@timestamp': input.source.timestamp, block_num: input.source.blockNum,
            block_id: input.source.blockId, producer: input.source.producer, trx_id: body.id});
        delete action.except;
        if (action.error_code === null) delete action.error_code;
        const fact = input.wireActionInputs.find(value => value.transactionId === body.id && value.actionOrdinal === action.action_ordinal);
        assert(fact, 'Original action must have a provider-observed input');
        action.protocol = {schemaVersion: 1,
            source: {chainId: input.source.chainId, blockNum: input.source.blockNum, blockId: input.source.blockId},
            selectionId: input.sourceSelectionId, input: fact};
        const decision = decisions.find(value => value.origin.transactionId === body.id && value.origin.actionOrdinal === fact.inputActionOrdinal);
        assert(decision, 'Installed native profile must classify the original occurrence');
        if (decision.kind === 'native') {
            action.protocol = {...action.protocol, schemaVersion: 2, kind: 'native', native: {
                nativeKind: decision.nativeKind, contextId: 'h45srcctx1:' + '1'.repeat(64),
                linkId: 'h45srcnat1:' + '2'.repeat(64), observationId: 'h45natobs1:' + '3'.repeat(64),
                observationDigest: '4'.repeat(64), inventorySha256: '5'.repeat(64),
                captureRef: {abiObservationId: 'h45abi1:' + '6'.repeat(64), abiObservationDigest: '7'.repeat(64), inputSha256: '8'.repeat(64)},
                profile: {id: selected.id, profileId: selected.provider.profileId, components: selected.components}}};
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
    const documents = group(processed, true);
    for (const document of documents) {
        document.act_digest = document.receipts[0].act_digest;
        for (const receipt of document.receipts) delete receipt.act_digest;
        if (document.context_free === false) delete document.context_free;
    }
    return documents;
}

export async function qualifyActionHandoffOutcomes({client, chain, targetIndex, check, instrument, report}) {
    const admission = process.env.HYPERION_NATIVE_SOURCE_PROFILE
        ? (await import('../../tests/unit/stateful-engineering-source-admission.mjs')).admitNativeSourceEnvironment() : undefined;
    const wireRevision = admission?.wireRevision ?? legacyWireRevision, sdkRevision = admission?.sdkRevision ?? legacySdkRevision;
    const [{ActionSourceAdmissionStore, actionSourceAdmissionHeader}, {publishAdmittedActionWithEvidence},
        {actionHistoryImmutableJson}, {deriveActionSourceInventory}, {loadChainProtocol},
        {normalizeActionSequences}, {groupActionTraces}, {currentActionConfiguration}] = await Promise.all([
        import('../../build/indexer/history/action-source-admission.js'),
        import('../../build/indexer/history/action-confirmed-publication.js'),
        import('../../build/indexer/history/action-history-manifest.js'),
        import('../../build/indexer/history/action-source-inventory.js'),
        import('../../build/indexer/protocol/selection.js'),
        import('../../build/indexer/helpers/action-sequences.js'),
        import('../../build/indexer/helpers/action-dedup.js'),
        import('../../build/indexer/history/action-producer-epoch.js')]);
    assert(targetIndex.startsWith(chain + '-action-'), 'Outcome target must belong to the runner');
    const settings = (await client.indices.getSettings({index: targetIndex, flat_settings: true}))[targetIndex];
    const target = {name: targetIndex, uuid: settings?.settings?.['index.uuid']};
    assert.equal(typeof target.uuid, 'string'); assert(target.uuid.length > 0);
    const wire = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
    const fixture = join(wire, 'fixtures/codec/native-onblock-6508-20261022');
    const receipt = readJson(join(wire, 'dist/protocol-source-receipt.json'));
    assert.equal(receipt.sourceRevision, wireRevision);
    const lock = readJson(new URL('../../package-lock.json', import.meta.url));
    for (const [name, revision] of [['hyperion-wire-plugin', wireRevision], ['hyperion-sdk', sdkRevision]])
        assert.ok(isPinnedGitSource(lock.packages[`node_modules/@eosrio/${name}`].resolved, name, revision));
    const manifest = readJson(join(fixture, 'manifest.json'));
    assert.equal(manifest.originalArchiveSha256, archiveSha256);
    for (const member of manifest.members) {
        const bytes = readFileSync(join(fixture, member.path));
        assert.equal(bytes.length, member.bytes); assert.equal(sha256(bytes), member.sha256);
    }
    const oracleBytes = readFileSync(join(fixture, 'expected.json')); assert.equal(sha256(oracleBytes), oracleSha256);
    const oracle = JSON.parse(oracleBytes).find(value => value.blockNum === 122); assert(oracle);
    const frameBytes = readFileSync(join(fixture, 'block-000122.bin'));
    const schemaJson = readFileSync(join(fixture, manifest.schema.path), 'utf8');
    const selected = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId});
    assert.equal(selected.provider.profileId, profileId); assert.equal(selected.provider.nativeActions.interfaceVersion, 1);
    assert(selected.components.every(value => value.sourceRevision === wireRevision));
    const session = selected.provider.createShipSession(JSON.parse(schemaJson));
    const store = new ActionSourceAdmissionStore(client, chain, 1), owners = new Set();
    const owner = () => {const value = controlledOwner(); owners.add(value); return value;};
    const configuration = currentActionConfiguration({
        conf: {settings: {chain, parser: '3.2', eosio_alias: 'sysio',
            protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId}},
        indexer: {disable_indexing: false, max_inline: 0}, scaling: {ad_idx_queues: 2},
        whitelists: {root_only: false, actions: [], deltas: [], max_depth: 0}, blacklists: {actions: [], deltas: []}},
        filters: {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()},
        mLoader: {snapshotActionHandlers: () => []}});
    const receiptObservations = [];
    try {
        const [, frame] = session.decodeResult(frameBytes);
        assert.equal(frame.this_block.block_id, oracle.blockId);
        const decodedBlock = session.decodeBlock(Buffer.from(frame.block, 'hex'));
        const traces = session.decodeTraces(Buffer.from(frame.traces, 'hex'));
        const source = {chainId: manifest.chainId, blockNum: 122, blockId: oracle.blockId, previousBlockId: frame.prev_block.block_id};
        const observed = selected.provider.observeBlockAbi({traces, accountRows: []}, source);
        const decisions = selected.provider.nativeActions.observe({schemaJson, block: Buffer.from(frame.block, 'hex'),
            traces: Buffer.from(frame.traces, 'hex')}, source).decisions;
        const inventoryInput = {profileId, source: {chainId: manifest.chainId, blockNum: 122, blockId: oracle.blockId,
            producer: decodedBlock.producer, timestamp: decodedBlock.timestamp},
        policy: {schemaVersion: 1, parserVersion: '3.2', actionBlacklist: [], actionWhitelist: [], rootOnly: false,
            maxDepth: 0, maxInline: 0, eosioAlias: 'sysio'}, traces, wireActionInputs: observed.actionInputs,
        sourceSelectionId: 'h45srcsel1:' + sha256(frameBytes)};
        const inventory = deriveActionSourceInventory(inventoryInput);
        const traceOrdinal = traces.findIndex(([, trace]) => trace.id === oracle.transactionId); assert(traceOrdinal >= 0);
        const transaction = inventory.transactions.find(value => value.traceOrdinal === traceOrdinal);
        assert.equal(transaction.transactionId, oracle.transactionId); assert(transaction.dispatch);
        const dispatchPayload = Buffer.from(transaction.dispatch.canonicalJson);
        const actions = groupedOutput(inventoryInput, traces[traceOrdinal], selected, decisions,
            normalizeActionSequences, groupActionTraces);
        const originalAction = actions.find(value => value.global_sequence === oracle.globalSequence); assert(originalAction);
        assert.deepEqual(originalAction.act.data, oracle.expectedValue);
        assert.equal(originalAction.protocol.input.rawHex, oracle.rawHex);

        async function prepare(label, boundTarget = target) {
            const captureSha256 = sha256(frameBytes);
            const ingressId = await store.retainIngress({schemaVersion: 1, chainId: manifest.chainId, protocolId: selected.id,
                profileId, components: selected.components, readerSessionId: 'constructed-component-reader',
                schemaJson, frameHex: frameBytes.toString('hex'), captureSha256});
            const sourceId = await store.retainSource({schemaVersion: 1, frameHex: frameBytes.toString('hex'), schemaJson,
                captureSha256, ingressId, previousBlockId: source.previousBlockId,
                producer: {protocolId: selected.id, profileId, codeRevision: report.source.gitHead,
                    configurationSha256: sha256(configuration), pluginsSha256: sha256('constructed-outcome-producer:' + label)},
                executableSha256: sha256('constructed-component-executable:' + report.source.gitHead), inventoryInput});
            const admission = await store.admit(sourceId, boundTarget);
            assert.equal(admission.incomplete, null); assert(admission.planId);
            const prepared = await store.prepareTransaction(admission, traceOrdinal, dispatchPayload, actions);
            return {admission, prepared, traceOrdinal, dispatchPayload, actions};
        }
        const headers = work => ({block_num: 122, [actionSourceAdmissionHeader]: work.admission.id,
            action_fragment_id: work.prepared.fragmentId});
        async function publications(work, owned, {route = 1, documents = work.actions} = {}) {
            const result = [];
            for (const document of documents) result.push(await publishAdmittedActionWithEvidence(owned.owner,
                `${chain}:index_actions:${route}`, Buffer.from(actionHistoryImmutableJson(document)), {headers: headers(work)}));
            assert(owned.state.calls.every(call => call.options.persistent === true && call.options.mandatory === true));
            return result;
        }
        const request = (work, owned, evidence) => ({admissionId: work.admission.id, traceOrdinal,
            dispatchPayload, configuration, owner: owned.owner, publications: evidence});
        const read = (reader, work) => reader.readConfirmedHandoff(work.admission.id, traceOrdinal, dispatchPayload);
        const isOutcome = write => write.request.document?.kind === 'manifest'
            && write.request.document.bundle_id?.startsWith('h45actionhandoff1:');

        await check('actual owned helper evidence roundtrips a real two-copy source-bound handoff outcome', async () => {
            const work = await prepare('roundtrip'), owned = owner();
            await assert.rejects(store.recordConfirmedHandoff(request(work, owned, [])), /publication|effect|empty|handoff|bound/i);
            const tracked = instrumentStores(client, store, instrument), writer = new ActionSourceAdmissionStore(tracked.client, chain, 1);
            const evidence = await publications(work, owned), recorded = await writer.recordConfirmedHandoff(request(work, owned, evidence));
            assert.match(recorded.id, /^h45actionhandoff1:[0-9a-f]{64}$/);
            assert.equal(recorded.outcome.kind, 'confirmed-action-handoff');
            assert.equal(recorded.outcome.work.admissionId, work.admission.id);
            assert.equal(recorded.outcome.work.sourceId, work.admission.sourceId);
            assert.equal(recorded.outcome.work.transactionId, oracle.transactionId);
            assert.deepEqual(recorded.outcome.work.target, target);
            assert.equal(recorded.outcome.effects.length, actions.length);
            assert(recorded.outcome.effects.some(value => value.effect.globalSequence === oracle.globalSequence));
            assert(recorded.outcome.effects.every(value => value.route === 'index_actions'));
            assert.deepEqual(await read(new ActionSourceAdmissionStore(client, chain, 1), work), recorded);
            assert(tracked.admission.durableReceipts.some(value => value.id === recorded.id && value.successful === 2 && value.failed === 0));
            receiptObservations.push(...tracked.admission.durableReceipts);
            return {id: recorded.id, effects: actions.length, originalBlock: 122, actualCopies: 2,
                controlledBroker: true, nativeLocatorsSynthetic: true, actualDsAck: false, sinkReadiness: false};
        });

        await check('confirmed buffered output needs its original drain before it can produce outcome evidence', async () => {
            const work = await prepare('buffered'), owned = owner();
            owned.state.writable = false; owned.state.automaticConfirm = false;
            let settled = false;
            const pending = publications(work, owned).then(value => {settled = true; return value;}); pending.catch(() => {});
            await tick(); assert.equal(owned.state.calls.length, 1); assert.equal(settled, false);
            owned.state.calls[0].confirm(null); await tick(); assert.equal(settled, false);
            owned.state.writable = true; owned.state.automaticConfirm = true;
            owned.publisher.emit('drain'); const evidence = await pending;
            assert.equal(owned.state.calls.length, work.actions.length, 'Each grouped effect is sent exactly once');
            const recorded = await store.recordConfirmedHandoff(request(work, owned, evidence));
            assert.deepEqual(await read(store, work), recorded);
            return {faultBoundary: 'Controlled confirm-channel buffering/drain', sends: work.actions.length, actualRabbit: false};
        });

        await check('duplicate same-effect handoff obtains fresh real receipts across round-robin attempt routes', async () => {
            const work = await prepare('duplicate'), owned = owner();
            const first = await store.recordConfirmedHandoff(request(work, owned, await publications(work, owned)));
            const tracked = instrumentStores(client, store, instrument), writer = new ActionSourceAdmissionStore(tracked.client, chain, 1);
            const second = await writer.recordConfirmedHandoff(request(work, owned, await publications(work, owned, {route: 2})));
            assert.deepEqual(second, first);
            assert(tracked.admission.writes.some(write => write.method === 'index' && write.request.id === first.id));
            assert(tracked.admission.durableReceipts.every(value => value.successful === 2 && value.failed === 0));
            receiptObservations.push(...tracked.admission.durableReceipts);
            return {stableOutcomeAcrossRouteAndMessageIds: true, freshOutcomeCas: true, actualCopies: 2};
        });

        for (const mode of ['nack', 'publisher-closed']) {
            await check(`controlled ${mode} cannot produce confirmation evidence or a retained success outcome`, async () => {
                const work = await prepare(mode), owned = owner(); owned.state.automaticConfirm = false;
                const pending = publications(work, owned); pending.catch(() => {});
                await tick(); assert.equal(owned.state.calls.length, 1);
                if (mode === 'nack') owned.state.calls[0].confirm(new Error('controlled broker NACK'));
                else owned.publisher.emit('close');
                await assert.rejects(pending, /NACK|closed/i);
                await assert.rejects(read(store, work));
                return {mode, faultBoundary: 'Controlled confirm-channel callback/event',
                    actualRabbitFailure: false, successfulEvidence: false, actualDsAck: false};
            });
        }

        for (const mode of ['before-write', 'lost-receipt', 'partial-receipt']) {
            await check(`controlled ${mode} rejects outcome success; GET cannot replace fresh complete-copy repair`, async () => {
                const work = await prepare(mode), owned = owner(); let injected = false;
                const tracked = instrumentStores(client, store, instrument, {
                    beforeWrite(write) {if (mode === 'before-write' && !injected && isOutcome(write)) {
                        injected = true; throw new Error('controlled outcome write refused before manifest');
                    }},
                    afterWrite(write, response) {
                        if (!injected && isOutcome(write)) {
                            injected = true;
                            if (mode === 'lost-receipt') throw new Error('controlled lost outcome receipt after real two-copy write');
                            if (mode === 'partial-receipt') return {...response, _shards: {...response._shards, total: 2, successful: 1, failed: 1}};
                        }
                        return response;
                    }});
                const writer = new ActionSourceAdmissionStore(tracked.client, chain, 1);
                await assert.rejects(writer.recordConfirmedHandoff(request(work, owned, await publications(work, owned))), /controlled|receipt|durab|cop/i);
                assert(injected);
                const observer = instrumentStores(client, store, instrument), reader = new ActionSourceAdmissionStore(observer.client, chain, 1);
                let seen;
                if (mode === 'before-write') await assert.rejects(read(reader, work));
                else seen = await read(reader, work);
                assert.equal(observer.admission.writes.length, 0); assert.equal(observer.journal.writes.length, 0);
                const repair = instrumentStores(client, store, instrument), restarted = new ActionSourceAdmissionStore(repair.client, chain, 1);
                const restored = await restarted.recordConfirmedHandoff(request(work, owned, await publications(work, owned, {route: 2})));
                if (seen) assert.deepEqual(restored, seen);
                assert(repair.admission.durableReceipts.some(value => value.id === restored.id && value.successful === 2 && value.failed === 0));
                if (mode !== 'before-write') assert(repair.admission.writes.some(write => write.method === 'index' && write.request.id === restored.id));
                receiptObservations.push(...repair.admission.durableReceipts);
                return {mode, faultBoundary: mode === 'before-write' ? 'Controlled pre-manifest call failure' : 'Controlled returned-response fault after real two-copy write',
                    observedBytesAreWriteReceipt: false, freshRepairRequired: true, actualReplicaOutage: false, actualDsAck: false};
            });
        }

        await check('forged, foreign-work and out-of-policy route evidence cannot inherit a successful outcome', async () => {
            const work = await prepare('evidence'), owned = owner(), evidence = await publications(work, owned);
            const other = await prepare('evidence-foreign-source');
            const wrongTarget = await prepare('evidence', {...target, uuid: target.uuid + '-foreign'});
            for (const invalid of [request(work, owned, evidence.map(value => structuredClone(value))),
                request(other, owned, evidence), request(wrongTarget, owned, evidence),
                request(work, owned, await publications(work, owned, {route: 3}))]) {
                await assert.rejects(store.recordConfirmedHandoff(invalid));
            }
            await assert.rejects(read(store, work));
            const successful = await store.recordConfirmedHandoff(request(work, owned, evidence));
            assert.deepEqual(await read(store, work), successful);
            return {serializedTicketRefused: true, foreignSourceAndTargetRefused: true, configuredRouteCount: 2,
                actualTargetUuidObserved: true, targetSinkCertified: false};
        });

        await check('changed effect bytes cannot overwrite an existing source-work outcome', async () => {
            const work = await prepare('effect-conflict'), owned = owner();
            const first = await store.recordConfirmedHandoff(request(work, owned, await publications(work, owned)));
            const changed = structuredClone(work.actions); changed[0].act.data = {...changed[0].act.data, controlled_conflict: true};
            const conflict = await publications(work, owned, {documents: changed});
            await assert.rejects(store.recordConfirmedHandoff(request(work, owned, conflict)), /conflict|fragment|effect|handoff|mismatch/i);
            assert.deepEqual(await read(store, work), first);
            return {controlledChangedOpaqueData: true, immutableOriginalOutcomePreserved: true};
        });

        for (const mode of ['owner-replaced', 'cancelled']) {
            await check(`controlled ${mode} after actual outcome write cannot return successful handoff`, async () => {
                const work = await prepare(mode), owned = owner(), controller = new AbortController(); let injected = false;
                const tracked = instrumentStores(client, store, instrument, {afterWrite(write, response) {
                    if (!injected && isOutcome(write)) {
                        injected = true;
                        if (mode === 'owner-replaced') owned.state.active = false;
                        else controller.abort(new Error('controlled cancellation after actual outcome write'));
                    }
                    return response;
                }});
                const writer = new ActionSourceAdmissionStore(tracked.client, chain, 1), evidence = await publications(work, owned);
                await assert.rejects(writer.recordConfirmedHandoff(request(work, owned, evidence), controller.signal));
                assert(injected);
                // This observation intentionally does not promote the failed call or acknowledge any input.
                const seen = await read(store, work); assert.equal(seen.outcome.kind, 'confirmed-action-handoff');
                return {actualWriteCopies: 2, faultBoundary: 'Controlled state/signal change after returned ES write',
                    successfulReturn: false, observedRecordGrantsCompletion: false, actualSocketCancellation: false, actualDsAck: false};
            });
        }

        report.observations.confirmedHandoffOutcomes = {index: store.index, target, profileId, wireRevision, sdkRevision,
            originalArchiveSha256: archiveSha256, oracleSha256, originalFrameSha256: sha256(frameBytes),
            sourceReceiptSha256: sha256(readFileSync(join(wire, 'dist/protocol-source-receipt.json'))),
            constructedProducerAndLocatorBindings: true, actualInstalledNativeCodec: true, actualCopies: 2,
            observedDurableReceipts: receiptObservations.length,
            everyObservedReceiptComplete: receiptObservations.every(value => value.successful === 2 && value.failed === 0),
            controlledBroker: true, actualDsAck: false, canonicalAuthorization: false,
            physicalSinkReadiness: false, capacityProtection: false, fullWorkerQualification: false};
        report.qualification.confirmedHandoffOutcomes = true;
    } finally {
        for (const owned of owners) owned.close();
        session.close?.();
    }
}
