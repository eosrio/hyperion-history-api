/** Actual master/coordinator, separate original native reader/MainDS/DS roles; service transports are controls. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Checksum256, UInt32} from '@wharfkit/antelope';
import {prepareReversibleWorkerInputs} from './reversible-worker-inputs.mjs';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {dispatchFixtureService} from './controlled-worker-service-transport.mjs';
import {encodeWorkerEvidence} from './reversible-worker-evidence.mjs';

const mode = process.argv[2] ?? 'baseline';
assert(['baseline', 'revoke', 'late-rpc'].includes(mode));
const evidencePath = process.argv[3];
if (evidencePath) {assert(isAbsolute(evidencePath)); assert(!existsSync(evidencePath), 'Never overwrite frozen observations');}
const directory = mkdtempSync(join(tmpdir(), 'hyperion-reversible-workers-'));
const originalDirectory = process.cwd(), originalConfig = process.env.CONFIG_JSON;
const states = [], publications = [], ends = [], errors = [], commands = new Map(), storageRequests = [];
let supervisor, coordinator, master, bindings, frontier, store, input, serviceAfter, heldRelease, rpcGate, rpcRelease, report, failure;
const chain = 'reversible-worker-original';
const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin',
    profileId: 'wire-sysio-6508c9e8-native-engineering-v1'}, eosio_alias: 'sysio', system_contract: 'sysio',
    index_version: 'v1', index_partition_size: 1000, es_replicas: 1,
    protocol_abi_coordination: {recovery_window_blocks: 256}},
    indexer: {fetch_block: true, fetch_traces: true, fetch_deltas: true, process_deltas: false,
        disable_indexing: false, live_reader: true},
    features: {contract_console: false, failed_trx: false, streaming: {traces: true, deltas: false}},
    scaling: {routing_mode: 'round_robin', ds_pool_size: 2, ds_queues: 1, ad_idx_queues: 1, indexing_queues: 1},
    api: {tx_cache_mode: 'batch', disable_tx_cache: false},
    whitelists: {actions: [], deltas: [], root_only: false}, blacklists: {actions: [], deltas: []}, plugins: {}};
let describeEnd;
async function until(predicate, label, milliseconds = 30_000) {
    const deadline = Date.now() + milliseconds;
    while (!predicate()) {
        assert(!errors.length && Date.now() < deadline, JSON.stringify({label, errors,
            states: states.map(s => ({name: s.name, pid: s.child.process.pid, exited: s.exited, exit: s.exitCode,
                stdout: s.stdout.slice(-1500), stderr: s.stderr.slice(-2500), events: s.messages.slice(-5)}))}));
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
function command(state, body) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {commands.delete(id); reject(new Error('Original native command did not finish: ' + body.operation));}, 30_000);
        commands.set(id, {state, resolve, reject, timer});
        state.child.send({event: 'qualification_command', id, input: body});
    });
}
function spawn(name, role) {
    const child = cluster.fork({CONFIG_JSON: join(directory, 'chain.json'), worker_role: role, live_mode: 'true',
        QUALIFICATION_CHAIN_ID: input.chainId, HYPERION_QUALIFICATION_PLAIN_PROOF: 'false',
        HYPERION_QUALIFICATION_PLAIN_HANDOFF: 'false'});
    const state = {name, role, child, messages: [], sent: [], stdout: '', stderr: '', exited: false};
    const originalSend = child.send.bind(child);
    child.send = (...args) => {state.sent.push(structuredClone(args[0])); return originalSend(...args);};
    states.push(state);
    child.on('exit', code => {
        state.exited = true; state.exitCode = code;
        for (const [id, pending] of commands) if (pending.state === state) {
            clearTimeout(pending.timer); commands.delete(id); pending.reject(new Error('Owned native child exited before command settlement: ' + name));
        }
    });
    child.process.stdout.on('data', bytes => {state.stdout += bytes;});
    child.process.stderr.on('data', bytes => {state.stderr += bytes;});
    child.on('message', message => {
        state.messages.push(message);
        if (message.event === 'qualification_service_request') {
            storageRequests.push({worker: name, ...structuredClone(message)});
            void dispatchFixtureService(child, message, memory, async (sender, body) => {
                publications.push({worker: name, role, ...structuredClone(body)}); return {confirmed: true};
            }, undefined, (...args) => serviceAfter ? serviceAfter(...args) : args[2])
                .catch(error => errors.push({name: error.name, message: error.message}));
        } else if (message.event === 'qualification_command_reply') {
            const pending = commands.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer); commands.delete(message.id);
            if (message.ok) pending.resolve(message.value);
            else pending.reject(Object.assign(new Error(message.error.message), message.error));
        } else if (['protocol_abi_coordinator_request', 'protocol_abi_source_revoked', 'protocol_source_probe_reply', 'protocol_abi_prepared'].includes(message.event)) {
            master.handleMessage(child, message);
        }
    });
    if (role !== 'continuous_reader') supervisor.attach(child, role);
    master.workerMap.push({wref: child, worker_role: role});
    if (role === 'continuous_reader') master.liveReader = master.workerMap.at(-1);
    return state;
}
const memory = frontierMemoryClient(1), hash = bytes => createHash('sha256').update(bytes).digest('hex');
memory.client.indices.exists = async ({index}) => memory.settings.has(index);
memory.settings.set(chain + '-action-v1-000001', {'index.uuid': 'owned-reversible-action-target'});
try {
    input = await prepareReversibleWorkerInputs(directory);
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: input.chainId}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    const [{HyperionMaster}, {HyperionModuleLoader}, {loadChainProtocol}, {ProtocolAbiCoordinator},
        {ProtocolSourceBindingStore}, {ProtocolAbiObservationStore}, {ProtocolAbiFrontierStore},
        {ActionSourceAdmissionStore}, supervisorModule] = await Promise.all([
        import('../../build/indexer/modules/master.js'), import('../../build/indexer/modules/loader.js'),
        import('../../build/indexer/protocol/selection.js'), import('../../build/indexer/protocol/abi-coordinator.js'),
        import('../../build/indexer/protocol/source-bindings.js'), import('../../build/indexer/protocol/abi-observation-store.js'),
        import('../../build/indexer/protocol/abi-frontier-store.js'), import('../../build/indexer/history/action-source-admission.js'),
        import('../../build/indexer/protocol/worker-attempt-supervisor.js')]);
    describeEnd = supervisorModule.describeWorkerAttemptEnd;
    supervisor = new supervisorModule.WorkerAttemptSupervisor({onEnd: value => ends.push(value)});
    const selected = await loadChainProtocol(config.settings.protocol);
    bindings = new ProtocolSourceBindingStore(memory.client, chain, 1);
    frontier = new ProtocolAbiFrontierStore(memory.client, chain, 1);
    store = new ActionSourceAdmissionStore(memory.client, chain, 1);
    coordinator = new ProtocolAbiCoordinator({chainId: input.chainId,
        profile: {id: selected.id, profileId: input.profileId, components: selected.components},
        ownerId: randomUUID(), bindings, observations: new ProtocolAbiObservationStore(memory.client, chain, 1), store: frontier,
        verifyNativeGenesis: selected.provider.verifyNativeGenesis.bind(selected.provider), nativeActionInterfaceVersion: 1});
    await coordinator.start();
    const filters = {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()};
    const loader = Object.assign(Object.create(HyperionModuleLoader.prototype), {handledActions: new Map(), plugins: []});
    master = Object.assign(Object.create(HyperionMaster.prototype), {chain, conf: config, esClient: memory.client,
        cm: {filters}, mLoader: loader, protocolAbiCoordinator: coordinator, workerAttemptSupervisor: supervisor,
        protocolSourceProbes: new Map(), workerMap: [], shutdownStarted: false, shouldCountIPCMessages: false,
        rpc: {v1: {chain: {get_info: async () => ({chain_id: Checksum256.from(input.chainId),
            head_block_num: UInt32.from(34), last_irreversible_block_num: UInt32.from(0)})}},
            call: async request => {
                assert.equal(request.path, '/v1/chain/get_block');
                const position = input.positions.get(request.params.block_num_or_id); assert(position);
                const response = {block_num: position.blockNum, id: position.blockId, previous: position.previousBlockId ?? '0'.repeat(64)};
                if (rpcGate && !rpcGate.entered) {rpcGate.entered = true; await rpcGate.released;}
                return response;
            }}});
    master.initHandlerMap();
    cluster.setupPrimary({exec: fileURLToPath(new URL('./reversible-original-worker.mjs', import.meta.url)), args: [], silent: true});
    const reader = spawn('reader', 'continuous_reader'), main = spawn('main', 'deserializer'),
        first = spawn('original-ds', 'ds_pool_worker'), peer = spawn('peer-ds', 'ds_pool_worker');
    await until(() => states.every(s => s.messages.some(m => m.event === 'qualification_ready')), 'Separate original native roles are ready');
    await Promise.all([main, first, peer].map(state => command(state, {operation: 'initialize', schemaJson: input.schemaJson})));
    const sourceOpened = await command(reader, {operation: 'initialize', schemaJson: input.schemaJson, statusHex: input.statusHex});
    assert.equal(master.protocolAbiSource.worker, reader.child);
    assert.equal(master.protocolAbiSource.readerSessionId, sourceOpened.readerSessionId);
    assert.equal(master.protocolAbiSource.generation, sourceOpened.coordinatorGeneration);
    let lastMain = 0;
    async function frame(number) {
        const before = publications.length;
        const receipt = await command(reader, {operation: 'frame', frameHex: input.frames[number - 1].frameHex});
        const raw = publications.slice(before).filter(p => p.worker === 'reader');
        assert.equal(raw.length, 1); assert.equal(raw[0].payloadHex, input.frames[number - 1].frameHex);
        await command(main, {operation: 'delivery', delivery: raw[0], tag: number});
        await coordinator.drain();
        const published = publications.slice(lastMain).filter(p => p.worker === 'main' && p.options.headers.block_num === number);
        lastMain = publications.length;
        return {receipt, published};
    }
    let selectedDispatch;
    for (let number = 1; number <= 33; number++) {
        const result = await frame(number);
        if (number === 33) selectedDispatch = result.published.find(p => p.options.headers.action_trace_ordinal === 0);
    }
    assert(selectedDispatch);
    function ownEnd(state, index = 0) {
        const request = state.messages.filter(m => m.event === 'worker_attempt_request' && m.payload.operation === 'register')[index]?.payload;
        return request && ends.find(e => {
            const end = describeEnd(supervisor, e);
            return end.incarnation === request.incarnation && end.attemptId === request.attemptId;
        });
    }
    const adjudicator = master.attemptAdjudicatorFor(supervisor);
    const associationIds = () => [...memory.documents.values()].map(x => x.document)
        .filter(x => x.kind === 'manifest' && x.bundle_id.startsWith('h45actionassociation1:')).map(x => x.bundle_id);
    async function associate(state, number, index = 0) {
        const evidence = ownEnd(state, index); assert(evidence);
        const end = describeEnd(supervisor, evidence), expected = input.expected.get(number);
        assert.equal(end.rootResult, 'returned'); assert.equal(end.status, 'quiescent'); assert.equal(end.freshWrites.length, 1);
        assert.equal(end.binding.blockNum, number); assert.equal(end.binding.blockId, expected.blockId);
        assert.throws(() => describeEnd(supervisor, structuredClone(end)), /Unissued or foreign/);
        const result = await adjudicator.adjudicate(evidence); assert.equal(result.state, 'associated');
        const association = (await store.readAttemptAssociation(result.id)).observation;
        assert.equal(association.sourceChecked, true); assert.equal(association.brokerSettlement, 'unknown');
        assert.equal(association.end.incarnation, end.incarnation); assert.equal(association.end.attemptId, end.attemptId);
        const actual = publications.filter(p => p.worker === state.name)[index]; assert(actual);
        const row = JSON.parse(Buffer.from(actual.payloadHex, 'hex').toString());
        assert.equal(row.global_sequence, expected.globalSequence); assert.equal(row.trx_id, expected.transactionId);
        assert.equal(row.protocol.native.nativeKind, expected.nativeKind); assert.deepEqual(row.act.data, expected.expectedValue);
        return {end, associationId: result.id};
    }
    let result, revoked, lateRpc;
    if (mode === 'baseline') {
        await command(first, {operation: 'delivery', delivery: selectedDispatch, tag: 1});
        result = await associate(first, 33);
    } else if (mode === 'revoke') {
        let held;
        const released = new Promise(resolve => {heldRelease = resolve;});
        serviceAfter = async (sender, message, value) => {
            const hasFresh = first.messages.some(m => m.event === 'worker_attempt_request' && m.payload.operation === 'observe'
                && m.payload.write.kind === 'confirmed-handoff');
            if (!held && sender === first.child && hasFresh && message.kind === 'es'
                && message.body.method === 'get' && message.body.body.index === frontier.controlIndex
                && message.body.body.id === 'control' && message.diagnostic.signalPassed) {
                held = {message, response: structuredClone(value), settled: false};
                await released; held.settled = true;
            }
            return value;
        };
        const original = command(first, {operation: 'delivery', delivery: selectedDispatch, tag: 1});
        original.catch(() => {});
        await until(() => !!held, 'Original post-fresh read holds its original returned control bytes');
        const before = await command(first, {operation: 'effects'});
        assert(before.scope.pendingOperations >= 1); assert.equal(before.effects.originalAcks, 0);
        assert.equal(before.effects.publisherDispatches, 1); assert.equal(ownEnd(first), undefined);
        assert.equal(held.settled, false); assert.equal(associationIds().length, 0);
        await command(reader, {operation: 'revoke'});
        await until(() => master.protocolAbiSource === undefined && first.messages.some(m => m.event === 'qualification_scope_fenced'),
            'Actual authenticated reader revocation fences original worker');
        await coordinator.drain();
        const oldSelectionId = selectedDispatch.options.headers['hyperion-source-selection-v1'];
        const selected = (await bindings.readSelection(oldSelectionId)).selection;
        assert.equal(await coordinator.currentlyAdmittedSource(oldSelectionId, selected.source,
            sourceOpened.readerSessionId, sourceOpened.coordinatorGeneration), false);
        await until(() => first.messages.some(m => m.event === 'qualification_post_fence_probe'), 'Original native proof rejects post-fence reuse');
        const fenced = first.messages.find(m => m.event === 'qualification_scope_fenced');
        const probe = first.messages.find(m => m.event === 'qualification_post_fence_probe');
        assert(fenced.scope.pendingOperations >= 1); assert.equal(fenced.scope.state, 'fenced');
        assert.equal(probe.accepted, false); assert.equal(probe.code, 'worker_attempt_fenced'); assert.equal(probe.ownsFence, true);
        assert.deepEqual(probe.effects, fenced.effects); assert.equal(held.settled, false); assert.equal(ownEnd(first), undefined);
        const replacement = await command(reader, {operation: 'reconnect', schemaJson: input.schemaJson, statusHex: input.statusHex});
        assert.notEqual(replacement.readerSessionId, sourceOpened.readerSessionId);
        assert.notEqual(replacement.coordinatorGeneration, sourceOpened.coordinatorGeneration);
        assert.equal(master.protocolAbiSource.readerSessionId, replacement.readerSessionId);
        const next = await frame(34), delivery = next.published.find(p => p.options.headers.action_trace_ordinal === 0); assert(delivery);
        await command(peer, {operation: 'delivery', delivery, tag: 1});
        // The original required IO is still owned while an independent original worker genuinely completes.
        assert.equal(held.settled, false); assert.equal(ownEnd(first), undefined);
        const peerEvidence = ownEnd(peer); assert(peerEvidence);
        for (const changed of ['configuration', 'target']) {
            const originalSettings = memory.client.indices.getSettings;
            let entered, release, once = false;
            const enteredRead = new Promise(resolve => {entered = resolve;}), releasedRead = new Promise(resolve => {release = resolve;});
            memory.client.indices.getSettings = async request => {
                const value = await originalSettings(request);
                if (!once && request.index === chain + '-action-v1-000001') {once = true; entered(); await releasedRead;}
                return value;
            };
            try {
                const pending = adjudicator.adjudicate(peerEvidence); pending.catch(() => {}); await enteredRead;
                if (changed === 'configuration') config.indexer.disable_indexing = true;
                else memory.settings.get(chain + '-action-v1-000001')['index.uuid'] = 'replaced-physical-target';
                release(); assert.deepEqual(await pending, {state: 'unresolved'}); assert.equal(associationIds().length, 0);
            } finally {
                release(); memory.client.indices.getSettings = originalSettings; config.indexer.disable_indexing = false;
                memory.settings.get(chain + '-action-v1-000001')['index.uuid'] = 'owned-reversible-action-target';
            }
        }
        result = await associate(peer, 34);
        const priorPeerEnd = result.end, conditional = [];
        memory.faults.beforeWrite = async (request, method) => {
            if (request.index === store.index && request.id === priorPeerEnd.freshWrites[0].id && method === 'index') {
                assert.equal(request.wait_for_active_shards, 'all'); assert(Number.isSafeInteger(request.if_seq_no));
                assert(Number.isSafeInteger(request.if_primary_term)); conditional.push(structuredClone(request));
            }
        };
        await command(peer, {operation: 'delivery', delivery, tag: 2, redelivered: true});
        delete memory.faults.beforeWrite;
        const redelivery = await associate(peer, 34, 1);
        assert.equal(conditional.length, 1); assert.equal(redelivery.end.incarnation, priorPeerEnd.incarnation);
        assert.notEqual(redelivery.end.attemptId, priorPeerEnd.attemptId);
        assert.equal(redelivery.end.freshWrites[0].id, priorPeerEnd.freshWrites[0].id);
        assert.equal(held.settled, false); assert.equal(ownEnd(first), undefined);
        heldRelease();
        await assert.rejects(original, error => ['worker_attempt_fenced', 'native_cancelled', 'proof_cancelled'].includes(error.code));
        const evidence = ownEnd(first); assert(evidence);
        const oldEnd = describeEnd(supervisor, evidence);
        assert.equal(oldEnd.rootResult, 'threw'); assert.equal(oldEnd.status, 'quiescent');
        assert.equal(oldEnd.acknowledgementAttempted, false); assert.equal(oldEnd.freshWrites.length, 1);
        assert.deepEqual(await adjudicator.adjudicate(evidence), {state: 'unresolved'});
        const after = await command(first, {operation: 'effects'});
        assert.equal(after.scope.state, 'drained'); assert.equal(after.scope.pendingOperations, 0);
        assert.equal(after.effects.originalAcks, 0); assert.equal(after.effects.publisherDispatches, before.effects.publisherDispatches);
        assert.equal(after.effects.storageDispatches, fenced.effects.storageDispatches);
        assert.equal(after.effects.cacheDispatches, fenced.effects.cacheDispatches);
        assert.equal(after.effects.streamDispatches, fenced.effects.streamDispatches);
        assert.equal(associationIds().length, 2);
        revoked = {oldEnd, pendingAtFence: fenced.scope.pendingOperations, retainedResponseSha256: hash(Buffer.from(JSON.stringify(held.response))),
            replacement, peerAssociatedBeforeOriginalSettlement: true, redelivery, conditionalWrites: conditional.length,
            currentConfigurationAndTargetLateReadsRejected: true, oldScopeEffectsAfterFence: after.effects};
    } else {
        await command(first, {operation: 'delivery', delivery: selectedDispatch, tag: 1});
        const originalEvidence = ownEnd(first), originalEnd = describeEnd(supervisor, originalEvidence);
        assert.equal(originalEnd.rootResult, 'returned'); assert.equal(originalEnd.freshWrites.length, 1);
        const released = new Promise(resolve => {rpcRelease = resolve;});
        rpcGate = {entered: false, released};
        const pendingObservation = adjudicator.current.canonicalBlock(33);
        pendingObservation.catch(() => {});
        await until(() => rpcGate.entered, 'Actual canonical RPC response is held after the master captures its current source');
        assert.equal(associationIds().length, 0);
        await command(reader, {operation: 'revoke'});
        await until(() => master.protocolAbiSource === undefined, 'Authenticated source is revoked during original canonical RPC await');
        await coordinator.drain(); rpcRelease();
        const observation = await pendingObservation;
        assert.equal(observation.blockId, input.positions.get(33).blockId); assert.equal(observation.irreversible, false);
        assert.throws(() => adjudicator.current.assertCanonicalCurrent(observation), /source scope is no longer current/);
        assert.throws(() => adjudicator.current.assertCanonicalCurrent(structuredClone(observation)), /Unissued canonical/);
        rpcGate = undefined;
        assert.deepEqual(await adjudicator.adjudicate(originalEvidence), {state: 'unresolved'});
        assert.equal(associationIds().length, 0);
        const replacement = await command(reader, {operation: 'reconnect', schemaJson: input.schemaJson, statusHex: input.statusHex});
        assert.notEqual(replacement.readerSessionId, sourceOpened.readerSessionId);
        assert.notEqual(replacement.coordinatorGeneration, sourceOpened.coordinatorGeneration);
        const next = await frame(34), delivery = next.published.find(p => p.options.headers.action_trace_ordinal === 0); assert(delivery);
        await command(peer, {operation: 'delivery', delivery, tag: 1});
        result = await associate(peer, 34);
        assert.deepEqual(await adjudicator.adjudicate(originalEvidence), {state: 'unresolved'});
        assert.equal(associationIds().length, 1);
        lateRpc = {originalEnd, replacement, oldCanonicalObservationRejected: true,
            sourceStillHasSameCanonicalBlockIdentity: true, oldEndUnresolvedAfterReplacement: true};
    }
    const admission = await store.resolve(result.end.binding.admissionId);
    report = {passed: true, mode, actualMasterCoordinator: true, originalSeparateNativeWorkers: true,
        realReversibleReaderProbe: true, readerSessionId: sourceOpened.readerSessionId, generation: sourceOpened.coordinatorGeneration,
        ...result, revoked, lateRpc, sourceArchiveSha256: input.sourceArchiveSha256,
        sourcePayloadUnchanged: true, producer: admission.source.producer, executableSha256: admission.source.executableSha256,
        constructedReversibleEnvelopesAndTransports: true, capacityAuthority: false, releaseQualified: false};
    for (const state of states) state.child.send({event: 'qualification_finish'});
    await until(() => states.every(s => s.exited), 'Exact owned native workers exit');
    for (const state of states) {assert.equal(state.exitCode, 0, state.stderr); assert.equal(state.stderr, '');}
    report.processes = states.map(s => {
        const ready = s.messages.find(m => m.event === 'qualification_ready');
        return {name: s.name, role: s.role, pid: s.child.process.pid, exitCode: s.exitCode,
            node: ready.runtime, executableSha256: ready.executableSha256, execArgv: ready.execArgv, nodeOptions: ready.nodeOptions};
    });
} catch (error) {
    failure = {name: error.name, code: error.code, message: error.message, stack: error.stack}; throw error;
} finally {
    heldRelease?.();
    rpcRelease?.();
    for (const pending of commands.values()) {clearTimeout(pending.timer); pending.reject(new Error('Owned fixture stopped'));}
    commands.clear();
    for (const state of states) if (!state.exited) {state.forcedKill = true; try {state.child.process.kill();} catch {}}
    if (states.some(s => !s.exited)) await until(() => states.every(s => s.exited), 'Failed-case exact owned process cleanup', 5000).catch(() => {});
    supervisor?.stop(); process.chdir(originalDirectory);
    if (originalConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = originalConfig;
    if (evidencePath) {
        const fixtureFiles = ['controlled-worker-service-transport.mjs', 'reversible-worker-inputs.mjs',
            'reversible-original-worker.mjs', 'reversible-original-attempts.mjs', 'reversible-worker-evidence.mjs'].map(path => {
            const bytes = readFileSync(new URL(path, import.meta.url)); return {path, bytes: bytes.length, sha256: hash(bytes)};
        });
        const snapshot = {schemaVersion: 1, mode, report: failure ? null : report, failure, fixtureFiles,
            inputs: input && {schemaJson: input.schemaJson, frames: input.frames, expected: [...input.expected]},
            stores: {documents: [...memory.documents], mappings: [...memory.mappings], settings: [...memory.settings], sequences: [...memory.sequences]},
            ends: ends.map(e => describeEnd(supervisor, e)), storageRequests,
            processes: states.map(s => ({name: s.name, role: s.role, pid: s.child.process.pid, exited: s.exited,
                exitCode: s.exitCode, forcedKill: !!s.forcedKill, stdout: s.stdout, stderr: s.stderr,
                received: s.messages, sent: s.sent}))};
        const encoded = encodeWorkerEvidence(snapshot), bytes = encoded.bytes;
        writeFileSync(evidencePath, bytes, {flag: 'wx'});
        if (!failure) report.evidence = {path: evidencePath, bytes: bytes.length, sha256: hash(bytes),
            encoding: 'interned-json-strings-v1', uniqueStrings: encoded.strings, references: encoded.references};
    }
    assert.equal(dirname(directory), resolve(tmpdir())); assert.match(basename(directory), /^hyperion-reversible-workers-/);
    rmSync(directory, {recursive: true, force: true});
}
console.log(JSON.stringify(report));
