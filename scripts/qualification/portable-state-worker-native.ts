/** Native engineering extension of the existing #191 tracer. No input/provider is injected. */
import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Client} from '@elastic/elasticsearch';
import {boundedPortableFile, portableSourceHash, portableWorkerSourceFrame, type PortableWorkerSource} from './portable-state-worker-source.ts';

export const portableNativeProfile = 'wire-sysio-6508c9e8-native-engineering-v1';
export const portableLegacyProfile = 'wire-sysio-6508c9e8-engineering-v1';
export const portableNativeArchive = '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7';
export const portableNativeChain = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
export function assertPortableNativeUnavailable(response: {status: number; body: any}, codes: readonly string[]) {
    assert.equal(response.status, 503); assert.equal(response.body.statusCode, 503);
    // The existing HTTP protocol-proof errors expose named503 codes; state endpoints additionally expose retryable:true.
    assert.ok(response.body.retryable === true || codes.includes(response.body.code), 'unavailable response lacks its retryable proof-failure contract');
    assert.equal(response.body.actions, undefined); assert.equal(response.body.simple_actions, undefined);
}
export function nativePortableHolds(original: readonly number[]) {
    assert.deepEqual(original, [1244, 1480], 'native qualification requires the original independently derived row prefixes');
    // The extra256 hold verifies all genuine notifications before their default256 ancestry expires.
    return [...new Set([1, 33, 122, 256, 397, ...original])].sort((a, b) => a - b);
}
const sequence = (value: unknown) => {assert.equal(typeof value, 'string'); assert.match(value as string, /^(?:0|[1-9][0-9]*)$/);
    assert.ok(BigInt(value as string) <= 0xffffffffffffffffn);};
export async function assertPortableNativeAction(action: any, expected: any,
    encode: (kind: string, value: unknown) => Uint8Array | Promise<Uint8Array>) {
    assert.equal(action.block_num, expected.blockNum); assert.equal(action.block_id, expected.blockId);
    assert.equal(action.trx_id, expected.transactionId); assert.equal(action.action_ordinal, expected.actionOrdinal);
    assert.equal(action.global_sequence, expected.globalSequence); sequence(action.global_sequence);
    assert.equal(action.protocol.schemaVersion, 2); assert.equal(action.protocol.kind, 'native');
    assert.equal(action.protocol.status, undefined); assert.equal(action.protocol.native.nativeKind, expected.nativeKind);
    assert.equal(action.protocol.native.profile.profileId, portableNativeProfile);
    assert.equal(action.protocol.input.rawHex, expected.rawHex); assert.equal(action.protocol.input.inputActionOrdinal, expected.actionOrdinal);
    assert.equal(action.protocol.input.globalSequence, expected.globalSequence);
    assert.equal(action.protocol.source.blockNum, expected.blockNum); assert.equal(action.protocol.source.blockId, expected.blockId);
    assert.deepEqual(action.act.data, expected.expectedValue, 'native data must preserve the original onblock header wrapper');
    assert.equal(Buffer.from(await encode(expected.nativeKind, action.act.data)).toString('hex'), expected.rawHex,
        'persisted native value must encode to the exact original bytes, including complete exhaustion');
    assert.ok(Array.isArray(action.receipts) && action.receipts.length > 0);
    for (const receipt of action.receipts) {sequence(receipt.global_sequence); sequence(receipt.recv_sequence);
        for (const authorization of receipt.auth_sequence) sequence(authorization.sequence);}
}

/** Retained original bytes and official clio receipts bind expectations before any services start. */
export async function auditPortableNativeOracle(source: PortableWorkerSource) {
    assert.equal(source.chainId, portableNativeChain); assert.equal(source.profileId, portableNativeProfile); assert.equal(source.endBlock, 1480);
    const root = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
    const directory = join(root, 'fixtures/codec/native-onblock-6508-20261022');
    const manifestBytes = await boundedPortableFile(join(directory, 'manifest.json'), 65536), manifest = JSON.parse(manifestBytes.toString());
    assert.equal(manifest.originalArchiveSha256, portableNativeArchive); assert.equal(manifest.chainId, source.chainId);
    assert.equal(manifest.upstreamRevision, source.sourceRevision); assert.equal(manifest.profileId, portableLegacyProfile,
        'the original oracle profile is provenance and must never be rewritten as native activation');
    const hashes: Record<string, string> = {'manifest.json': portableSourceHash(manifestBytes)};
    for (const member of manifest.members) {const bytes = await boundedPortableFile(join(directory, member.path), 8 * 1024 * 1024);
        assert.equal(bytes.length, member.bytes); assert.equal(portableSourceHash(bytes), member.sha256); hashes[member.path] = member.sha256;}
    const rows = JSON.parse((await boundedPortableFile(join(directory, 'expected.json'), 65536)).toString());
    assert.equal(hashes['expected.json'], 'f2d022f14e493f2297034dd8e7e1846d1504f19bbf1278afee8cd30a955b9720');
    assert.deepEqual(rows.map((row: any) => row.blockNum), [33, 122, 397]);
    for (const row of rows) {assert.equal(row.blockId, source.records[row.blockNum - 1].blockId);
        assert.equal(portableSourceHash(portableWorkerSourceFrame(source, row.blockNum)), hashes[`block-${String(row.blockNum).padStart(6, '0')}.bin`]);
        assert.equal(portableSourceHash(Buffer.from(row.rawHex, 'hex')), row.rawSha256);}
    const official = JSON.parse((await boundedPortableFile(join(directory, 'official-clio-receipt.json'), 65536)).toString());
    assert.equal(official.scope, 'read-only-original-source-official-clio-offline-conversions');
    assert.equal(official.clioSha256, '7485be43e7fd441f6a6e52f57b14f8859a768a59ae1226f80fbaad3c906f298e');
    for (const row of rows) {
        const converted = official.results.filter((item: any) => item.block === row.blockNum && item.kind === 'native-header');
        assert.equal(converted.length, 1); const conversion = converted[0]; assert.equal(conversion.rawSha256, row.rawSha256);
        assert.equal(conversion.exitCode, 0);
        for (const stream of [conversion.stdout, conversion.stderr]) {const bytes = Buffer.from(stream.base64, 'base64');
            assert.equal(bytes.length, stream.bytes); assert.equal(portableSourceHash(bytes), stream.sha256);}
        assert.equal(conversion.stderr.bytes, 0); const header = JSON.parse(Buffer.from(conversion.stdout.base64, 'base64').toString());
        if (row.blockNum === 397) {assert.equal(header.new_finalizer_policy_diff.threshold, 6); header.new_finalizer_policy_diff.threshold = '6';}
        assert.deepEqual(row.expectedValue, {header}, 'native expectations differ from the retained official header conversion');
    }
    return {directory, manifest, hashes, rows};
}

interface NativeRunOptions {
    readonly source: PortableWorkerSource; readonly oracle: Awaited<ReturnType<typeof auditPortableNativeOracle>>;
    readonly client: Client; readonly chain: string; readonly apiPort: number;
    readonly events: () => Promise<any[]>;
    readonly http: (path: string) => Promise<{status: number; headers: Headers; body: any}>;
    readonly unrelated: (through: number) => Promise<unknown>;
    readonly bulk: {readonly directory: string; readonly receipts: readonly any[]};
    readonly wait: (name: string, work: () => Promise<void>) => Promise<void>;
}

/** Native proof services are read-only. Constructed negative controls touch only one owned action row. */
export async function createPortableNativeQualification(options: NativeRunOptions) {
    const {source, oracle, client, chain, wait} = options;
    assert.match(chain, /^hyp-p191-[0-9a-f]{12}$/);
    const modules = await Promise.all(['protocol/selection', 'protocol/abi-frontier-store', 'protocol/abi-proof',
        'protocol/native-observation-store', 'protocol/native-authorization', 'history/action-source-admission',
        'history/action-source-inventory', 'history/action-history-manifest', 'history/action-sequence-storage',
        'protocol/native-observation-facts', 'protocol/abi-observation-store', 'protocol/immutable-bundle-store'].map(path =>
        import(new URL(`../../build/indexer/${path}.js`, import.meta.url).href)));
    const [selection, frontierModule, proofs, nativeModule, authorization, admissionModule, inventoryModule, manifests,
        sequences, nativeFacts, abiModule, immutable] = modules;
    const selected = await selection.loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: portableNativeProfile});
    assert.deepEqual(selected.components, source.components); assert.equal(selected.provider.nativeActions.interfaceVersion, 1);
    const provider = selected.provider, profile = {id: selected.id, profileId: source.profileId, components: selected.components};
    const frontier = new frontierModule.ProtocolAbiFrontierStore(client, chain, 1, {readOnly: true});
    // No maxAncestryBlocks override: this is the actual default256 reader contract.
    const reader = new proofs.ProtocolAbiProofReader({chainId: source.chainId, profile, store: frontier});
    const nativeStore = new nativeModule.ProtocolNativeObservationStore(client, chain, 1, undefined, {readOnly: true});
    const native = new authorization.ProtocolNativeActionReader({chainId: source.chainId, profile, provider, proofReader: reader, store: nativeStore});
    const admissionStore = new admissionModule.ActionSourceAdmissionStore(client, chain, 1);
    const session = provider.createShipSession(JSON.parse(source.schemaJson));
    const originals = new Map<number, any>(), notifications: any[] = [];
    try {
        for (let number = 1; number <= 397; number++) {
            const raw = portableWorkerSourceFrame(source, number), [, frame] = session.decodeResult(raw);
            const position = {chainId: source.chainId, blockNum: number, blockId: source.records[number - 1].blockId,
                previousBlockId: source.records[number - 1].previousBlockId};
            assert.equal(frame.this_block.block_id, position.blockId);
            const capture = {kind: 'unattested-ship-result-sections-v1', schemaJson: source.schemaJson,
                blockHex: frame.block, tracesHex: frame.traces, deltasHex: frame.deltas};
            if (number === 1) {assert.equal(capture.tracesHex, null); originals.set(number, {position, raw, capture, occurrences: []}); continue;}
            const traces = session.decodeTraces(Buffer.from(frame.traces, 'hex'));
            const occurrences = inventoryModule.deriveProtocolActionOccurrences(traces), inputs = occurrences.map((item: any) => item.input);
            const observed = nativeFacts.snapshotProtocolNativeDecisions(provider.nativeActions.observe({schemaJson: source.schemaJson,
                block: Buffer.from(frame.block, 'hex'), traces: Buffer.from(frame.traces, 'hex')}, position), inputs);
            const block = session.decodeBlock(Buffer.from(frame.block, 'hex'));
            const abi = provider.observeBlockAbi({traces, accountRows: []}, position);
            assert.deepEqual(abi.actionInputs, inputs, 'independent installed observer and original host occurrence derivation disagree');
            for (const occurrence of occurrences) if (occurrence.input.receiver !== occurrence.input.account) {
                const origin = inputs.find((value: any) => value.transactionId === occurrence.input.transactionId
                    && value.actionOrdinal === occurrence.input.inputActionOrdinal);
                assert.ok(origin && origin.receiver === origin.account);
                assert.equal(occurrence.input.rawHex, origin.rawHex); assert.equal(occurrence.input.account, origin.account);
                const decision = observed.decisions.find((value: any) => value.origin.transactionId === origin.transactionId
                    && value.origin.actionOrdinal === origin.actionOrdinal);
                assert.equal(decision.kind, 'contract', 'this original corpus contains no genuine native notification');
                notifications.push({blockNum: number, occurrence, origin, decision});
            }
            originals.set(number, {position, raw, capture, traces, block, occurrences, observed,
                inventory: nativeFacts.protocolNativeInputInventory(inputs), inputSha256: abiModule.protocolAbiCaptureDigest(position, capture)});
        }
    } finally {session.close?.();}
    assert.equal(notifications.length, 25); assert.equal(new Set(notifications.map(value => value.blockNum)).size, 17);
    let lastNativeThrough = 0;
    const checkedNotifications = new Set<string>(), held: any[] = [], controls: any[] = [];
    const persistedOutputs = new Map<string, {index: string; id: string; physicalSha256: string; logicalSha256: string; blockNum: number}>();
    const path = (number: number) => `/v2/history/get_actions?after=${number}&before=${number}&filter=sysio:onblock&hydrate=false&limit=100`;
    const receipt = (response: {status: number; headers: Headers; body: any}) => ({status: response.status, headers: Object.fromEntries(response.headers), body: response.body});
    const completeSearch = (response: any) => {assert.equal(response.timed_out, false); assert.equal(response._shards.failed, 0);
        assert.ok(response._shards.total > 0); assert.equal(response._shards.successful, response._shards.total);};
    const actions = async (number: number) => {
        const response = await client.search<any>({index: chain + '-action-*', size: 1024, track_total_hits: true,
            query: {term: {block_num: number}}}); completeSearch(response);
        assert.equal(typeof response.hits.total, 'object'); assert.equal((response.hits.total as any).relation, 'eq');
        assert.equal((response.hits.total as any).value, response.hits.hits.length);
        return response.hits.hits.map(hit => ({index: hit._index, id: hit._id!, physical: hit._source!, logical: sequences.restoreActionSequenceStorage(hit._source)}));
    };
    const selectionEvent = (events: any[], number: number) => {const rows = events.filter(value => value.kind === 'native_boundary'
        && value.event === 'native_prepare_readback' && value.blockNum === number); assert.equal(rows.length, 1); return rows[0];};
    const durable = async (events: any[], number: number) => {
        const event = selectionEvent(events, number), retained = await nativeStore.readSelection(event.selectionId);
        const original = originals.get(number)!; assert.equal(retained.linkId, event.linkId);
        assert.equal(retained.link.observationId, event.observationId); assert.equal(retained.link.observationDigest, event.observationDigest);
        assert.equal(retained.selection.frameSha256, portableSourceHash(original.raw)); assert.deepEqual(retained.record.source, original.position);
        assert.equal(immutable.protocolImmutableJson(retained.record.protocol), immutable.protocolImmutableJson(profile));
        assert.deepEqual(retained.abiObservation.capture, original.capture);
        assert.equal(retained.record.captureRef.inputSha256, retained.selection.captureSha256);
        const begun = events.find(value => value.kind === 'native_boundary' && value.event === 'native_prepare_begin'
            && value.selectionId === event.selectionId && value.pid === event.pid);
        const sourceAck = events.find(value => value.kind === 'native_boundary' && value.event === 'source_ack_sent'
            && value.blockNum === number && value.pid === event.pid);
        assert.ok(begun && sourceAck); assert.ok(begun.sequence < event.sequence && event.sequence < sourceAck.sequence,
            'actual durable native PREPARE readback must precede the owning source ACK');
        if (number === 1) {
            assert.equal(retained.record.inventory, null); assert.equal(retained.record.observation.status, 'incomplete');
            assert.equal(retained.record.observation.error.code, 'native_source_traces_absent');
            assert.equal(retained.abiObservation.observation.status, 'native-genesis');
        } else {assert.deepEqual(retained.record.inventory, original.inventory);
            assert.deepEqual(retained.record.observation, {status: 'observed', facts: original.observed});}
        return {event, retained, original, sourceAck};
    };
    const admission = async (events: any[], number: number, physical: Awaited<ReturnType<typeof actions>>) => {
        const eventsForBlock = events.filter(value => value.kind === 'native_boundary' && value.event === 'action_admitted' && value.blockNum === number);
        assert.equal(eventsForBlock.length, 1); const event = eventsForBlock[0], current = await admissionStore.resolve(event.admissionId);
        const original = originals.get(number); assert.ok(original);
        assert.equal(current.source.frameHex, original.raw.toString('hex')); assert.equal(current.source.schemaJson, source.schemaJson);
        assert.equal(current.source.inventoryInput.profileId, portableNativeProfile);
        assert.equal(current.source.producer.profileId, portableNativeProfile);
        const ingress = await admissionStore.resolveIngress(current.source.ingressId);
        assert.equal(ingress.frameHex, current.source.frameHex); assert.equal(ingress.profileId, portableNativeProfile);
        assert.equal(ingress.schemaJson, source.schemaJson); assert.equal(ingress.captureSha256, current.source.captureSha256);
        if (number === 1) {assert.equal(current.planId, null); assert.ok(current.incomplete); assert.equal(current.source.inventoryInput.traces, null);
            assert.equal(physical.length, 0); return {event, current, ingress};}
        assert.equal(current.incomplete, null); assert.ok(current.planId && current.inventory);
        assert.deepEqual(current.source.inventoryInput.traces, original.traces);
        assert.equal(current.source.inventoryInput.sourceSelectionId, selectionEvent(events, number).selectionId);
        assert.equal(current.source.producer.codeRevision.length, 40);
        const {manifest, id} = await admissionStore.journal.readManifest(current.planId);
        const {plan} = await admissionStore.journal.readPlan(current.planId);
        assert.deepEqual(plan.producer, current.source.producer); assert.equal(plan.source.blockId, source.records[number - 1].blockId);
        const expectedEffects = physical.map(value => manifests.fingerprintActionHistoryEffect(value.logical))
            .sort((a: any, b: any) => BigInt(a.globalSequence) < BigInt(b.globalSequence) ? -1 : 1);
        const actualEffects = manifest.fragments.flatMap((fragment: any) => fragment.effects)
            .sort((a: any, b: any) => BigInt(a.globalSequence) < BigInt(b.globalSequence) ? -1 : 1);
        assert.deepEqual(actualEffects, expectedEffects, 'persisted complete action seals must fingerprint every actual stored output');
        assert.equal(current.inventory.transactions.reduce((sum: number, value: any) => sum + value.groups.length, 0), physical.length);
        for (const row of physical) {
            // Actual admitted DS production uses actionHistoryImmutableJson for publication bytes (ds-pool.ts).
            // Its canonical sorted keys survive ES object insertion-order changes; ordinary JSON.stringify does not.
            const logicalSha256 = portableSourceHash(manifests.actionHistoryImmutableJson(row.logical));
            const confirmed = events.filter(value => value.kind === 'native_boundary' && value.event === 'admitted_broker_confirmed'
                && value.queue.startsWith(chain + ':index_actions:') && value.payloadSha256 === logicalSha256
                && value.headers['hyperion-action-admission-v1'] === current.id);
            assert.equal(confirmed.length, 1, 'stored output lacks one actual confirmed publication from its admitted source');
            assert.equal(confirmed[0].canonicalPayloadSha256, logicalSha256);
            assert.equal(confirmed[0].persistent, true); assert.equal(confirmed[0].mandatory, true);
            const fragment = manifest.fragments.find((fragment: any) => fragment.effects.some((effect: any) => effect.globalSequence === row.logical.global_sequence));
            assert.ok(fragment); assert.equal(confirmed[0].headers.action_fragment_id, manifests.actionHistoryFragmentId(fragment, plan));
            persistedOutputs.set(JSON.stringify([row.index, row.id]), {index: row.index, id: row.id, logicalSha256,
                physicalSha256: portableSourceHash(manifests.actionHistoryImmutableJson(row.physical)), blockNum: number});
        }
        return {event, current, ingress, manifestId: id, manifest};
    };
    return {profile, oracleHashes: oracle.hashes, held, controls, originalNotifications: notifications,
        async hold(through: number) {
            let events: any[] = [];
            await wait(`native PREPARE and source ACK through${through}`, async () => {
                events = await options.events();
                for (const event of ['native_prepare_readback', 'source_ack_sent']) assert.deepEqual(events.filter(value =>
                    value.kind === 'native_boundary' && value.event === event && value.blockNum <= through).map(value => value.blockNum),
                Array.from({length: through}, (_, index) => index + 1));
            });
            const control = await frontier.readControl(); assert.ok(control); assert.equal(control.value.head.blockNum, through);
            assert.equal(control.value.profile.profileId, portableNativeProfile); assert.equal(control.value.phase, 'following');
            const commit = await frontier.readCommit(control.value.head.commitId);
            assert.equal(commit.nativeActionInterfaceVersion, 1); assert.equal(commit.source.blockId, source.records[through - 1].blockId);
            const result: any = {through, control, commit, notifications: [], native: null};
            if (through === 1) {const raw = await durable(events, 1), membership = await admission(events, 1, await actions(1));
                await assert.rejects(native.open(raw.original.position, raw.event.selectionId), {code: 'native_source_incomplete'});
                result.genesis = {raw, membership, wholeHistoryCompleteness: false};}
            const target = oracle.rows.find((value: any) => value.blockNum === through);
            if (target) {
                const raw = await durable(events, through), physical = await actions(through);
                const row = physical.find(value => value.logical.trx_id === target.transactionId && value.logical.action_ordinal === target.actionOrdinal);
                assert.ok(row); await assertPortableNativeAction(row.logical, target, provider.nativeActions.encodeValue.bind(provider.nativeActions));
                const view = await native.open(raw.original.position, raw.event.selectionId);
                const decision = await native.authorize(view, row.logical.protocol.input); assert.equal(decision.kind, 'native');
                assert.deepEqual(await native.metadata(decision.grant), row.logical.protocol);
                assert.deepEqual(await native.decodeValue(decision.grant), target.expectedValue);
                const response = await options.http(path(through)); assert.equal(response.status, 200, JSON.stringify(response.body));
                const served = response.body.actions.find((value: any) => value.trx_id === target.transactionId);
                assert.ok(served); assert.deepEqual(served.act.data, target.expectedValue); assert.equal(served.global_sequence, target.globalSequence);
                result.native = {raw, physical, membership: await admission(events, through, physical), response: receipt(response)};
                if (through === 397) {
                    // Constructed stored-output controls are separate from the unchanged genuine replay source.
                    for (const kind of ['exact-raw-fallback', 'corrupt-raw-value', 'incomplete-native-metadata']) {
                        const changed = structuredClone(row.physical);
                        if (kind === 'exact-raw-fallback') {changed.act.data = target.rawHex; changed.protocol.status = 'incomplete';
                            changed.protocol.error = {code: 'qualification_constructed_raw', message: 'Constructed raw fallback remains raw-only'};}
                        else if (kind === 'corrupt-raw-value') changed.act.data = (target.rawHex.startsWith('00') ? '01' : '00') + target.rawHex.slice(2);
                        else {changed.protocol.status = 'incomplete'; changed.protocol.error = {code: 'qualification_constructed_incomplete', message: 'Constructed owned-row negative control'};}
                        assert.ok(row.index.startsWith(chain + '-action-')); let negative;
                        try {
                            await client.index({index: row.index, id: row.id, document: changed, refresh: 'wait_for'});
                            negative = await options.http(path(through));
                            if (kind === 'exact-raw-fallback') {assert.equal(negative.status, 200);
                                const rawRow = negative.body.actions.find((value: any) => value.trx_id === target.transactionId);
                                assert.ok(rawRow); assert.equal(rawRow.act.data, target.rawHex); assert.equal(rawRow.act.data.header, undefined);}
                            else assertPortableNativeUnavailable(negative, kind === 'corrupt-raw-value'
                                ? ['native_value_unavailable', 'native_value_mismatch'] : ['api_action_proof_unavailable']);
                            const unrelated = await options.unrelated(through); controls.push({kind, provenance: 'constructed-owned-action-row-only',
                                unchangedSourceSha256: portableSourceHash(raw.original.raw), response: receipt(negative), unrelated});
                        } finally {await client.index({index: row.index, id: row.id, document: row.physical, refresh: 'wait_for'});}
                        const restored = await client.get<any>({index: row.index, id: row.id}); assert.deepEqual(restored._source, row.physical);
                        assert.equal((await options.http(path(through))).status, 200);
                    }
                }
            }
            if (through <= 397) {
                for (const number of [...new Set(notifications.filter(value => value.blockNum > lastNativeThrough && value.blockNum <= through).map(value => value.blockNum))]) {
                    assert.ok(through - number <= 256); const raw = await durable(events, number), view = await native.open(raw.original.position, raw.event.selectionId);
                    const canonical = await reader.open(raw.original.position, raw.event.selectionId), physical = await actions(number);
                    const rows: any[] = [];
                    for (const expected of notifications.filter(value => value.blockNum === number)) {
                        const occurrence = await reader.occurrence(canonical, expected.occurrence.input);
                        assert.equal(occurrence.binding.inputActionOrdinal, expected.origin.actionOrdinal);
                        assert.equal((await native.authorize(view, expected.occurrence.input)).kind, 'contract');
                        const grouped = physical.filter(value => value.logical.trx_id === expected.occurrence.input.transactionId
                            && value.logical.receipts.some((receipt: any) => receipt.global_sequence === expected.occurrence.input.globalSequence));
                        assert.equal(grouped.length, 1); const storedReceipt = grouped[0].logical.receipts.find((receipt: any) => receipt.global_sequence === expected.occurrence.input.globalSequence);
                        assert.deepEqual(storedReceipt, expected.occurrence.receipt);
                        assert.equal(grouped[0].logical.protocol.schemaVersion, 1);
                        assert.equal(grouped[0].logical.protocol.input.inputActionOrdinal, expected.origin.actionOrdinal);
                        const identity = `${number}:${expected.occurrence.input.transactionId}:${expected.occurrence.input.actionOrdinal}`;
                        assert.ok(!checkedNotifications.has(identity)); checkedNotifications.add(identity); rows.push({expected, occurrence, stored: grouped[0]});
                    }
                    result.notifications.push({blockNum: number, raw, canonical, rows, membership: await admission(events, number, physical)});
                }
                lastNativeThrough = through;
            }
            if (through === 397) assert.equal(checkedNotifications.size, 25);
            held.push(result); return result;
        },
        async final() {
            assert.equal(checkedNotifications.size, 25); assert.equal(controls.length, 3);
            const expired: any[] = [], events = await options.events();
            for (const expected of oracle.rows) {
                const event = selectionEvent(events, expected.blockNum), retained = await nativeStore.readSelection(event.selectionId);
                const position = {chainId: source.chainId, blockNum: expected.blockNum, blockId: expected.blockId};
                await assert.rejects(reader.open(position, event.selectionId), {code: 'ancestry_unavailable'});
                await assert.rejects(native.open(position, event.selectionId), {code: 'ancestry_unavailable'});
                const response = await options.http(path(expected.blockNum)); assertPortableNativeUnavailable(response, ['ancestry_unavailable']);
                assert.equal(retained.abiObservation.capture.blockHex, originals.get(expected.blockNum).capture.blockHex);
                const membership = await admission(events, expected.blockNum, await actions(expected.blockNum));
                expired.push({blockNum: expected.blockNum, decoded: receipt(response), retainedSelectionId: event.selectionId,
                    rawCaptureSha256: retained.record.captureRef.inputSha256, retainedIngressSha256: portableSourceHash(Buffer.from(membership.ingress.frameHex, 'hex')),
                    rawHistory: await options.unrelated(expected.blockNum)});
            }
            const confirmedBulk: any[] = [], unmatched = new Set(persistedOutputs.keys());
            for (const entry of options.bulk.receipts) {
                assert.match(entry.request.file, /^[0-9]{5}-request\.ndjson$/);
                const bytes = await boundedPortableFile(join(options.bulk.directory, entry.request.file), 16 * 1024 * 1024);
                assert.equal(bytes.length, entry.request.bytes); assert.equal(portableSourceHash(bytes), entry.request.sha256);
                if (entry.status < 200 || entry.status >= 300) continue;
                assert.match(entry.responseBody.file, /^[0-9]{5}-response\.json$/);
                const responseBytes = await boundedPortableFile(join(options.bulk.directory, entry.responseBody.file), 16 * 1024 * 1024);
                assert.equal(responseBytes.length, entry.responseBody.bytes); assert.equal(portableSourceHash(responseBytes), entry.responseBody.sha256);
                assert.deepEqual(JSON.parse(responseBytes.toString()), entry.response);
                const lines = bytes.toString().trimEnd().split('\n'); let ordinal = 0;
                for (let offset = 0; offset < lines.length; ordinal++) {
                    const metadata = JSON.parse(lines[offset++]), operation = Object.keys(metadata)[0], target = metadata[operation];
                    const document = operation === 'delete' ? undefined : JSON.parse(lines[offset++]);
                    const index = target._index ?? entry.operations[ordinal].index, key = JSON.stringify([index, String(target._id)]);
                    const expected = persistedOutputs.get(key); if (!expected || !['index', 'create'].includes(operation)) continue;
                    assert.equal(portableSourceHash(manifests.actionHistoryImmutableJson(document)), expected.physicalSha256,
                        'actual worker bulk bytes differ from independently read physical native/notification output');
                    const result = entry.response.items[ordinal][operation]; assert.equal(result._index, expected.index);
                    assert.equal(String(result._id), expected.id); assert.ok(result.status >= 200 && result.status < 300 && !result.error);
                    if (result._shards) {assert.equal(result._shards.failed, 0); assert.ok(result._shards.successful >= 1);}
                    unmatched.delete(key); confirmedBulk.push({requestNumber: entry.number, operationOrdinal: ordinal,
                        expected, result, requestSha256: entry.request.sha256, responseSha256: entry.responseBody.sha256});
                }
            }
            assert.equal(unmatched.size, 0, 'some checked native/notification outputs lack captured successful worker bulk receipts');
            return {expired, confirmedBulk, verifiedNotifications: checkedNotifications.size, notificationBlocks: 17, defaultAncestryBlocks: 256,
                admissionActivation: 'existing-explicit-engineering-preload; public/default operator activation remains disabled',
                historicalServingQualified: false, fullForkRecoveryQualified: false, streamCompatibilityQualified: false};
        }};
}
