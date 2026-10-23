/** Private attempt lifecycle qualification through emitted classes and controlled I/O.
 * These cases grant no source credit and do not qualify the complete Wire/Mongo path. */
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProofConsumerScope, assertProofConsumerEnd, currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {ProtocolAbiProofReader} from '../../build/indexer/protocol/abi-proof.js';
import {ProtocolAbiCoordinator} from '../../build/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiObservationStore, protocolAbiCaptureDigest} from '../../build/indexer/protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {ProtocolNativeObservationStore} from '../../build/indexer/protocol/native-observation-store.js';
import {protocolNativeInputInventory} from '../../build/indexer/protocol/native-observation-facts.js';
import {ProtocolNativeActionReader} from '../../build/indexer/protocol/native-authorization.js';
import {deriveProtocolActionInputs} from '../../build/indexer/history/action-source-inventory.js';
import {publishAdmittedActionWithEvidence, readConfirmedActionPublications, confirmedActionPublicationBytes}
    from '../../build/indexer/history/action-confirmed-publication.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const gate = () => {
    let release;
    const promise = new Promise(resolve => {release = resolve;});
    return {promise, release};
};
const cases = [];
const chainId = '1'.repeat(64);
const profile = {id: 'qualification-fixture', profileId: 'attempt-lifecycle-v1', components: [
    {id: 'owned-fixture', runtime: 'node', version: '0.0.0-dev.1', sourceRevision: 'b'.repeat(40), sha256: 'c'.repeat(64)}]};
const hash = value => createHash('sha256').update(value).digest('hex');
const blockId = height => height.toString(16).padStart(64, '0');

/** Constructed host protocol and controlled storage; actual coordinator/store/readers issue every proof. */
async function nativeFixture() {
    const chain = 'attempt-proof-fixture', memory = frontierMemoryClient(), client = memory.client;
    const bindings = new ProtocolSourceBindingStore(client, chain), observations = new ProtocolAbiObservationStore(client, chain);
    const frontier = new ProtocolAbiFrontierStore(client, chain), nativeStore = new ProtocolNativeObservationStore(client, chain);
    const schemaJson = '{"fixture":"attempt-lifecycle-v1"}';
    const input = {transactionId: 'a'.repeat(64), actionOrdinal: 1, inputActionOrdinal: 1,
        receiver: 'alpha', account: 'alpha', name: 'dispatch', rawHex: '0102', globalSequence: '7', receiptAbiSequence: '0'};
    const facts = inputs => ({schemaVersion: 1, decisions: inputs.map(value => ({
        origin: {transactionId: value.transactionId, actionOrdinal: value.actionOrdinal, rawSha256: hash(Buffer.from(value.rawHex, 'hex'))},
        kind: 'native', nativeKind: 'owned.host-native.v1'}))});
    const calls = {observe: 0, decode: 0, encode: 0};
    const provider = {profileId: profile.profileId, nativeActions: {interfaceVersion: 1,
        observe(bytes, source) {calls.observe++; assert.deepEqual(JSON.parse(Buffer.from(bytes.block).toString()), source);
            return facts(source.blockNum === 2 ? [input] : []);},
        decodeValue(kind, bytes) {calls.decode++; assert.equal(kind, 'owned.host-native.v1'); return {rawHex: Buffer.from(bytes).toString('hex')};},
        encodeValue(kind, value) {calls.encode++; assert.equal(kind, 'owned.host-native.v1'); return Buffer.from(value.rawHex, 'hex');}},
        createShipSession() {return {decodeTraces: bytes => JSON.parse(Buffer.from(bytes).toString()), close() {}};}};
    const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson})).id;
    const coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'owned-host-parent', bindings,
        observations, store: frontier, nativeActionInterfaceVersion: 1});
    await coordinator.start(); let generation = (await coordinator.openSource(contextId, 'owned-host-source')).generation;
    async function append(height, replacementId = blockId(height)) {
        const source = {chainId, blockNum: height, blockId: replacementId, previousBlockId: height === 1 ? null : blockId(height - 1)};
        const inputs = height === 2 ? [input] : [];
        const traces = !inputs.length ? [] : [['transaction_trace_v0', {id: input.transactionId, status: 0,
            scheduled: false, failed_dtrx_trace: null, except: null, error_code: null, cpu_usage_us: 0, net_usage_words: 0,
            action_traces: [['action_trace_v1', {
                action_ordinal: 1, creator_action_ordinal: 0, receiver: 'alpha', context_free: false, except: null, error_code: null,
                act: {account: 'alpha', name: 'dispatch', authorization: [], data: '0102'},
                receipt: ['action_receipt_v0', {receiver: 'alpha', global_sequence: '7', recv_sequence: '7', auth_sequence: [],
                    act_digest: 'f'.repeat(64), code_sequence: 0, abi_sequence: 0}]}]]}]];
        assert.deepEqual(deriveProtocolActionInputs(traces), inputs, 'constructed raw source independently derives the literal occurrence');
        const capture = {kind: 'unattested-ship-result-sections-v1', schemaJson,
            blockHex: Buffer.from(JSON.stringify(source)).toString('hex'), tracesHex: Buffer.from(JSON.stringify(traces)).toString('hex'), deltasHex: '00'};
        const captureSha256 = protocolAbiCaptureDigest(source, capture);
        const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: 'owned-host-source',
            readerRole: 'live', assignmentId: null, source, captureSha256, frameSha256: hash(JSON.stringify([source, capture])),
            head: {blockNum: height, blockId: source.blockId}, irreversible: {blockNum: 0, blockId: blockId(0)}})).id;
        const abi = await observations.prepare({schemaVersion: 1, protocol: profile, source: {...source, inputSha256: captureSha256}, capture,
            observation: {status: 'observed', facts: {schemaVersion: 1, actionInputs: inputs, deployments: [], finalStates: []}}});
        await bindings.prepareObservationLink({schemaVersion: 1, selectionId, observationId: abi.id, observationDigest: abi.digest});
        await nativeStore.prepare(selectionId, {schemaVersion: 1, kind: 'observation', nativeInterfaceVersion: 1, contextId, protocol: profile,
            source, captureRef: {abiObservationId: abi.id, abiObservationDigest: abi.digest, inputSha256: captureSha256},
            inventory: protocolNativeInputInventory(inputs), observation: {status: 'observed', facts: facts(inputs)}});
        const admitted = await coordinator.admit(selectionId, generation); assert.equal(admitted.status, 'accepted'); generation = admitted.generation;
        await coordinator.drain(); return {source, selectionId};
    }
    await append(1); const selected = await append(2);
    const proofs = managed => new ProtocolAbiProofReader({chainId, profile,
        store: new ProtocolAbiFrontierStore(client, chain, 0, {readOnly: true}), requireAttemptScope: managed});
    const reader = proofReader => new ProtocolNativeActionReader({chainId, profile, provider,
        store: new ProtocolNativeObservationStore(client, chain, 0, undefined, {readOnly: true}), proofReader});
    return {memory, frontier, input, selected, calls, proofs, reader, append};
}

async function reentrantRootClosure() {
    const scope = new ProofConsumerScope('reentrant-original-root'), held = gate();
    const events = [];
    let ending, ended = false;
    const root = scope.run(async () => {
        events.push('root-entered');
        ending = scope.closeAndDrain().then(end => {ended = true; events.push('end-issued'); return end;});
        await held.promise;
        events.push('root-finalizer-ended');
    });
    try {
        await turn();
        assert.equal(ended, false, 'a synchronous close callback cannot erase the still-running original root');
        held.release();
        await root;
        assertProofConsumerEnd(scope, await ending);
        assert.deepEqual(events, ['root-entered', 'root-finalizer-ended', 'end-issued']);
        assert.equal(scope.snapshot().state, 'drained');
        cases.push({id: 'reentrant-root-before-close', events});
    } finally {
        held.release();
        await Promise.allSettled([root, ending]);
    }
}

async function reentrantOperationClosure() {
    const scope = new ProofConsumerScope('reentrant-original-operation'), held = gate(), events = [];
    let ending, ended = false;
    const operation = scope.operation(async () => {
        events.push('operation-entered');
        ending = scope.closeAndDrain().then(end => {ended = true; events.push('end-issued'); return end;});
        await held.promise;
        events.push('operation-ended');
    });
    try {
        await turn();
        assert.equal(ended, false, 'the actual operation must be registered before its callback can close the scope');
        held.release(); await operation;
        const end = await ending;
        assertProofConsumerEnd(scope, end);
        assert.deepEqual(events, ['operation-entered', 'operation-ended', 'end-issued']);
        let invoked = 0;
        assert.throws(() => scope.operation(() => {invoked++;}), /no longer permits/);
        assert.equal(invoked, 0);
        assert.throws(() => assertProofConsumerEnd(scope, {}), /Unissued or foreign/);
        assert.throws(() => assertProofConsumerEnd(new ProofConsumerScope('foreign'), end), /Unissued or foreign/);
        cases.push({id: 'reentrant-operation-before-close', events, lateInvocations: invoked});
    } finally {held.release(); await Promise.allSettled([operation, ending]);}
}

async function reentrantAbortEndIdentity() {
    const scope = new ProofConsumerScope('reentrant-close-signal');
    await scope.run(() => undefined);
    let reentered;
    scope.signal.addEventListener('abort', () => {reentered = scope.closeAndDrain();}, {once: true});
    const first = scope.closeAndDrain();
    const [originalEnd, reentrantEnd] = await Promise.all([first, reentered]);
    assertProofConsumerEnd(scope, originalEnd); assertProofConsumerEnd(scope, reentrantEnd);
    // Both schedules have genuinely drained; this is one-use identity, not an early-drain oracle.
    assert.equal(first, reentered, 'synchronous abort reentry must share the original closing transition');
    assert.equal(originalEnd, reentrantEnd, 'one local attempt must issue one opaque local end');
    cases.push({id: 'abort-listener-reentrant-close-is-one-transition', sameClosingPromise: true, sameOpaqueEnd: true});
}

async function callerSourceSnapshot() {
    for (const managed of [false, true]) {
        let reads = 0;
        const reader = new ProtocolAbiProofReader({chainId, profile,
            store: {async readControl() {reads++; return null;}}, requireAttemptScope: managed});
        const scope = managed ? new ProofConsumerScope('managed-caller-snapshot') : undefined;
        const consume = async () => {
            const source = {chainId, blockNum: 1, blockId: '2'.repeat(64)};
            const opening = reader.open(source).catch(error => error);
            // API input ownership is fixed when open is called, before its first asynchronous boundary.
            source.chainId = '9'.repeat(64); source.blockNum = -1;
            const error = await opening;
            assert.equal(error.code, 'authority_unavailable', 'the original valid request must reach the actual authority read');
            assert.equal(reads, 1, 'caller mutation must not turn the original request into local validation failure');
        };
        try {
            if (scope) await scope.run(consume); else await consume();
            cases.push({id: managed ? 'managed-pre-await-source-snapshot' : 'public-pre-await-source-snapshot', reads});
        } finally {if (scope) await scope.closeAndDrain();}
    }
}

async function retainedViewsAndNativeClone() {
    const fixture = await nativeFixture(), proofReader = fixture.proofs(true), reader = fixture.reader(proofReader);
    const scope = new ProofConsumerScope('original-native-delivery');
    let abiView, nativeView, grant;
    await scope.run(async () => {
        abiView = await proofReader.open(fixture.selected.source, fixture.selected.selectionId);
        const input = {...fixture.input}, occurrence = proofReader.occurrence(abiView, input);
        input.globalSequence = '8'; input.rawHex = 'ffff';
        assert.equal((await occurrence).binding.globalSequence, '7', 'original occurrence input is snapped before the first read');
        nativeView = await reader.open(fixture.selected.source, fixture.selected.selectionId);
        const nativeInput = {...fixture.input}, decision = reader.authorize(nativeView, nativeInput);
        nativeInput.globalSequence = '8'; nativeInput.rawHex = 'ffff';
        const authorized = await decision; assert.equal(authorized.kind, 'native'); grant = authorized.grant;
        assert.deepEqual(await reader.decodeValue(grant), {rawHex: '0102'});
    });
    // Retained handles deliberately leave their originating async context. They keep their original scope.
    assert.deepEqual(await reader.decodeValue(grant), {rawHex: '0102'});
    const end = await scope.closeAndDrain(); assertProofConsumerEnd(scope, end);
    const before = {reads: fixture.memory.calls.length, ...fixture.calls};
    for (const operation of [() => proofReader.revalidate(abiView), () => proofReader.occurrence(abiView, fixture.input),
        () => reader.revalidate(nativeView), () => reader.authorize(nativeView, fixture.input),
        () => reader.metadata(grant), () => reader.decodeValue(grant), () => reader.verifyValue(grant, {rawHex: '0102'})]) {
        await assert.rejects(operation, error => error.code === 'worker_attempt_fenced');
    }
    assert.deepEqual({reads: fixture.memory.calls.length, ...fixture.calls}, before, 'closed handles must not call storage or a native codec');
    const publicReader = fixture.proofs(false);
    const publicView = await publicReader.open(fixture.selected.source, fixture.selected.selectionId);
    assert.equal((await publicReader.occurrence(publicView, fixture.input)).binding.globalSequence, '7');
    cases.push({id: 'issued-abi-native-and-grant-outside-context-after-close', deniedUses: 7, publicReaderUnaffected: true});
}

async function heldReadThroughNativeClone(cancellation = 'abort') {
    const fixture = await nativeFixture(), reader = fixture.reader(fixture.proofs(true));
    const entered = gate(), held = gate(), controller = new AbortController(), cancelled = {ownedRequest: 'cancelled'};
    let heldOnce = false, physicalPending = false;
    fixture.memory.faults.beforeRead = async request => {
        if (!heldOnce && request.index === fixture.frontier.controlIndex) {
            heldOnce = true; physicalPending = true; entered.release();
            try {await held.promise;} finally {physicalPending = false;}
        }
    };
    const scope = new ProofConsumerScope('native-read-only-clone');
    const root = scope.run(() => reader.waitForOpen(fixture.selected.source, fixture.selected.selectionId,
        {signal: controller.signal, timeoutMs: cancellation === 'timeout' ? 50 : 1000}));
    const rejected = root.catch(error => error);
    let ended = false, ending;
    try {
        await entered.promise;
        if (cancellation === 'abort') {
            controller.abort(cancelled);
            assert.equal(await rejected, cancelled, 'native cancellation keeps the exact caller reason');
        } else assert.equal((await rejected).code, 'proof_timeout');
        assert.equal(physicalPending, true);
        ending = scope.closeAndDrain().then(end => {ended = true; return end;});
        await turn(); assert.equal(ended, false, 'the inner read-only ABI clone must keep the native attempt unresolved');
        held.release(); assertProofConsumerEnd(scope, await ending); assert.equal(physicalPending, false);
        assert.equal(fixture.calls.observe, 0, 'aborted inner proof cannot later call the native observer');
        cases.push({id: 'native-read-only-clone-held-past-outer-' + cancellation, observerCalls: fixture.calls.observe});
    } finally {held.release(); await Promise.allSettled([root, ending]); delete fixture.memory.faults.beforeRead;}
}

async function retainedNativeReadDuringClose() {
    const fixture = await nativeFixture(), reader = fixture.reader(fixture.proofs(true));
    const scope = new ProofConsumerScope('retained-native-grant');
    let grant;
    await scope.run(async () => {
        const view = await reader.open(fixture.selected.source, fixture.selected.selectionId);
        const decision = await reader.authorize(view, fixture.input); assert.equal(decision.kind, 'native'); grant = decision.grant;
    });
    const entered = gate(), held = gate(); let heldOnce = false;
    fixture.memory.faults.beforeRead = async request => {
        if (!heldOnce && request.index === fixture.frontier.controlIndex) {heldOnce = true; entered.release(); await held.promise;}
    };
    const pending = reader.decodeValue(grant); pending.catch(() => {});
    let ending, ended = false;
    try {
        await entered.promise;
        ending = scope.closeAndDrain().then(end => {ended = true; return end;});
        await turn(); assert.equal(ended, false); assert.equal(fixture.calls.decode, 0);
        held.release();
        await assert.rejects(pending, error => ['worker_attempt_fenced', 'proof_cancelled'].includes(error.code));
        assertProofConsumerEnd(scope, await ending);
        assert.equal(fixture.calls.decode, 0, 'a retained-read continuation cannot enter the native codec after its original scope is fenced');
        cases.push({id: 'retained-native-grant-held-read-fenced-before-codec', nativeDecodeCalls: fixture.calls.decode});
    } finally {held.release(); await Promise.allSettled([pending, ending]); delete fixture.memory.faults.beforeRead;}
}

async function publicationPhysicalDrain(cancellation = 'abort', completion = 'drain') {
    class Publisher extends EventEmitter {
        calls = [];
        sendToQueue(queue, payload, options, confirm) {this.calls.push({queue, payload: Buffer.from(payload), options, confirm}); return false;}
    }
    const publisher = new Publisher(), consumer = new EventEmitter(), controller = new AbortController();
    const scope = new ProofConsumerScope('buffered-original-publication'), later = gate();
    const owner = {consumer, publisher, current: () => true};
    const cancelled = new Error('owned publication cancelled');
    let ticket, acknowledgments = 0, late, ending, ended = false;
    let root, deadline;
    const originalSetTimeout = globalThis.setTimeout;
    try {
        if (cancellation === 'timeout') globalThis.setTimeout = (callback, delay, ...arguments_) => {
            const timer = originalSetTimeout(callback, delay, ...arguments_);
            if (delay === 30_000) deadline = () => callback(...arguments_);
            return timer;
        };
        root = scope.run(async () => {
            // Promise continuation inherits the real host context, even when the root has already ended.
            late = later.promise.then(() => publishAdmittedActionWithEvidence(owner, 'owned:index_actions:1', Buffer.from('late'), {headers: {}})).catch(error => error);
            ticket = await publishAdmittedActionWithEvidence(owner, 'owned:index_actions:1', Buffer.from('original'), {headers: {}}, controller.signal);
            acknowledgments++;
        });
    } finally {globalThis.setTimeout = originalSetTimeout;}
    root.catch(() => {});
    try {
        assert.equal(publisher.calls.length, 1); const original = publisher.calls[0];
        assert.equal(original.options.mandatory, true); assert.equal(original.options.persistent, true);
        if (cancellation === 'abort') {controller.abort(cancelled); await assert.rejects(root, error => error === cancelled);}
        else {
            assert.equal(typeof deadline, 'function', 'the actual helper must install its literal thirty-second deadline');
            deadline(); await assert.rejects(root, /confirmation\/drain timed out/);
        }
        ending = scope.closeAndDrain().then(end => {ended = true; return end;});
        await turn(); assert.equal(ended, false, 'outer publication rejection cannot drain a held confirm and buffered send');
        if (completion === 'drain') {
            original.confirm(null); await turn(); assert.equal(ended, false, 'confirmation alone cannot drain buffered transport');
            publisher.emit('drain');
        } else publisher.emit('close');
        assertProofConsumerEnd(scope, await ending);
        original.confirm(null); publisher.emit('drain'); // Late physical callbacks cannot issue a ticket or new authority.
        await assert.rejects(() => publishAdmittedActionWithEvidence(owner, 'owned:index_actions:1', Buffer.from('outside'), {headers: {}}),
            error => error.code === 'worker_attempt_fenced');
        later.release(); const rejectedLate = await late;
        assert.equal(rejectedLate.code, 'worker_attempt_fenced');
        assert.equal(publisher.calls.length, 1, 'late host continuation cannot send a second output');
        assert.equal(ticket, undefined); assert.equal(acknowledgments, 0);
        cases.push({id: `publication-${cancellation}-awaits-physical-${completion}`, sent: publisher.calls.length, acknowledgments,
            ...(cancellation === 'timeout' ? {deadlineCallbackControlled: true, requestedTimeoutMs: 30_000, elapsedTimeClaim: false} : {})});
    } finally {
        later.release(); await turn();
        for (const call of publisher.calls) call.confirm(null);
        publisher.emit('drain'); publisher.emit('close');
        await Promise.allSettled([root, ending, late]);
    }
}

async function retainedPublicationTicketClosure() {
    const publisher = new EventEmitter();
    publisher.sendToQueue = (_queue, _payload, _options, callback) => {queueMicrotask(() => callback(null)); return true;};
    const owner = {publisher, consumer: new EventEmitter(), current: () => true}, scope = new ProofConsumerScope('issued-publication-ticket');
    const ticket = await scope.run(() => publishAdmittedActionWithEvidence(owner, 'owned:index_actions:1', Buffer.from('stable'), {headers: {source: 'original'}}));
    const [before] = readConfirmedActionPublications(owner, [ticket]);
    assert.equal(before.payload.toString(), 'stable'); assert.deepEqual(before.headers, {source: 'original'});
    assertProofConsumerEnd(scope, await scope.closeAndDrain());
    for (const operation of [() => readConfirmedActionPublications(owner, [ticket]), () => confirmedActionPublicationBytes(owner, [ticket])])
        assert.throws(operation, error => error.code === 'worker_attempt_fenced');
    cases.push({id: 'retained-issued-publication-ticket-outside-context-fenced', deniedReads: 2});
}

/** Actual controller/runtime scheduling; constructed source and adapter carry no canonical/Mongo evidence. */
async function projectionRoles(fenceAt = null) {
    const previousDirectory = process.cwd(), previousConfig = process.env.CONFIG_JSON;
    const directory = mkdtempSync(join(tmpdir(), 'hyperion-attempt-projection-'));
    mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
    const conf = {settings: {chain: 'attempt-projection'}, indexer: {}, features: {}, whitelists: {}, blacklists: {}};
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(conf));
    process.env.CONFIG_JSON = join(directory, 'chain.json'); process.chdir(directory);
    const {HyperionWorker} = await import('../../build/indexer/workers/hyperionWorker.js');
    const {PortableStateController} = await import('../../build/indexer/projection/controller.js');
    const {resolvePortableStateConfiguration} = await import('../../build/indexer/projection/config.js');
    const {PROJECTION_CAPABILITIES} = await import('@eosrio/hyperion-sdk/projection');
    const worker = Object.create(HyperionWorker.prototype); worker.installControlledAttemptLifecycle('projection');
    const definitions = ['first', 'other'].map(id => ({schemaVersion: 1, id, mappingRevision: 'a'.repeat(64),
        source: {contract: 'items', table: id, abiDeployment: 'constructed-source-epoch', abiSha256: 'b'.repeat(64)},
        fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}}));
    const configuration = resolvePortableStateConfiguration({backend: {kind: 'mongodb', id: 'fixture-backend', database: 'fixture'},
        projections: fenceAt ? definitions.slice(0, 1) : definitions}, chainId);
    const slots = new Map(), scopeAt = [], io = [], progress = [], held = gate(), entered = gate();
    let controller, initializationScope, frameScope, endings = [], revalidations = 0;
    const record = name => {
        // The controlled adapter records dispatch; it must not supply the host fence being tested.
        let scope;
        try {scope = currentProofConsumerScope(true);} catch (error) {
            if (!fenceAt || !frameScope) throw error; scope = frameScope;
        }
        io.push({name, state: scope.snapshot().state, id: scope.id}); return scope;
    };
    const adapter = {
        capabilities: {interfaceVersion: 1, supported: [...PROJECTION_CAPABILITIES]},
        async initialize(_definition, binding) {
            const scope = record('initialize:' + binding.projectionId); initializationScope ??= scope;
            slots.set(binding.projectionId, {binding, checkpoint: {blockNum: 0, blockId: '0'.repeat(64)}, initialized: true, pending: null, gap: null});
            return this.open(binding);
        },
        async open(binding) {const value = slots.get(binding.projectionId); return structuredClone({binding, checkpoint: value.checkpoint});},
        async recovery(binding) {record('recovery:' + binding.projectionId); return structuredClone(slots.get(binding.projectionId));},
        async apply(request) {
            record('apply:' + request.binding.projectionId); const value = slots.get(request.binding.projectionId);
            value.checkpoint = {blockNum: request.block.blockNum, blockId: request.block.blockId}; value.pending = null;
            return {status: 'applied', view: structuredClone({binding: value.binding, checkpoint: value.checkpoint})};
        },
        async markIncomplete(binding, block, reason) {record('mark:' + binding.projectionId);
            if (fenceAt === 'admission') {entered.release(); await held.promise;}
            slots.get(binding.projectionId).pending = {block, reason, digest: null};},
        async query(view) {return {view, rows: []};},
    };
    const source = {async frame(height, definition) {
        const scope = currentProofConsumerScope(true); frameScope ??= scope; scopeAt.push({projectionId: definition.id, scope});
        assert.equal(height, 1);
        return {frame: {chainId, block: {blockNum: 1, blockId: blockId(1), previousBlockId: '0'.repeat(64)},
            changes: [{contract: 'items', table: definition.id, scope: '', primaryKey: 'constructed-key',
                abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256,
                present: true, value: !fenceAt && definition.id === 'first' ? {} : {owner: 'alice'}}]},
            proof: {constructedSourceSeam: true}, evidence: {constructedSourceSeam: true}};
    }, async revalidate() {
        revalidations++;
        if (fenceAt === 'revalidation' && revalidations === 1) {entered.release(); await held.promise;}
    }};
    try {
        controller = await worker.runProjectionAttempt('projection-initialization', {constructedConfiguration: true}, () => PortableStateController.create({
            chainId, configuration, adapter, source, maximumFramesPerProjection: 1,
            attempts: {run: (metadata, operation) => worker.runProjectionAttempt('projection-frame', metadata, operation), bind: fields => worker.bindWorkerAttempt(fields)},
            onProgress: value => progress.push(value)}));
        assert.equal(initializationScope.snapshot().state, 'drained');
        if (fenceAt) {
            const work = controller.drain(); work.catch(() => {});
            await entered.promise; let ended = false;
            const ending = frameScope.closeAndDrain().then(end => {ended = true; return end;}); endings.push(ending);
            await turn(); assert.equal(ended, false, 'actual frame root remains live through held source revalidation');
            const atFence = io.length; held.release(); await Promise.allSettled([work, ending]);
            const later = io.slice(atFence);
            assert.deepEqual(later, [], 'fenced actual controller cannot dispatch new adapter work after its held source revalidation returns');
            assert.equal(slots.get('first').checkpoint.blockNum, 0);
            cases.push({id: 'projection-post-' + fenceAt + '-fence', newAdapterCallsAfterFence: later, checkpoint: 0, controlledSourceAndAdapter: true});
        } else {
            await controller.drain();
            assert.equal(slots.get('first').checkpoint.blockNum, 0); assert(slots.get('first').pending);
            assert.equal(slots.get('other').checkpoint.blockNum, 1); assert.equal(slots.get('other').pending, null);
            assert.equal(scopeAt.length, 2); assert.notEqual(scopeAt[0].scope, scopeAt[1].scope);
            for (const selected of scopeAt) {assert.notEqual(selected.scope, initializationScope); assert.equal(selected.scope.snapshot().state, 'drained');}
            assert(progress.some(value => value.projectionId === 'first' && value.status === 'incomplete'));
            assert(progress.some(value => value.projectionId === 'other' && value.status === 'applied'));
            assert.equal(io.filter(value => value.state !== 'open').length, 0);
            cases.push({id: 'actual-projection-initialization-and-independent-frame-roots', initializationRoots: 1, frameRoots: 2,
                contractFailureCheckpoint: 0, independentCheckpoint: 1, controlledSourceAndAdapter: true, masterAcceptedEnd: false});
        }
    } finally {
        held.release(); await Promise.allSettled(endings); await controller?.stop(); worker.workerAttemptClient.dispose();
        process.chdir(previousDirectory); if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
        const owned = resolve(directory); assert.equal(dirname(owned), resolve(tmpdir())); assert.match(basename(owned), /^hyperion-attempt-projection-/);
        rmSync(owned, {recursive: true, force: true});
    }
}

/** Existing original Wire fixture setup; controlled-local roots provide no parent evidence. */
async function originalWireRoles(workload = 'cache') {
const controlledAttemptLifecycle = (worker, role) => worker.installControlledAttemptLifecycle(role);
let nativeAddonResolutions = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) {nativeAddonResolutions++; throw new Error('Wire admission resolved the Antelope native addon');}
    return next(specifier, context);
}});
const previousDirectory = process.cwd(), previousSend = process.send;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-attempt-worker-original-'));
const chain = 'handoff-worker-original', chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d', blockId = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');

const events = [], sourceFrames = [], blockWrites = [], cache = [];
let reader, coordinator, draining = Promise.resolve();
process.send = (event, callback) => {
    events.push(event);
    if (event.event === 'protocol_abi_prepared') draining = coordinator.drain();
    callback?.(null); return true;
};
class ControlledConsumer extends EventEmitter {
    acked = [];
    streamed = [];
    onAck;
    ack(message) {this.onAck?.(message); this.acked.push(message);}
    publish(_exchange, queue, payload, options) {this.streamed.push({queue, payload: Buffer.from(payload), options: structuredClone(options)}); return true;}
}
class ControlledPublisher extends EventEmitter {
    sent = [];
    held;
    entered;
    automatic = true;
    writable = true;
    sendToQueue(queue, payload, options, confirm) {
        this.sent.push({queue, payload: Buffer.from(payload), options: structuredClone(options), confirm});
        if (!this.automatic) return this.writable;
        if (this.held) {this.entered?.(); this.held.then(() => confirm());}
        else queueMicrotask(() => confirm()); return this.writable;
    }
}
function message(sent) {return {content: Buffer.from(sent.payload), properties: {headers: structuredClone(sent.options.headers)}, fields: {deliveryTag: 1}};}
async function ticks() {for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve));}
function gate() {let release; const held = new Promise(resolve => {release = resolve;}); return {held, release};}
async function until(test, label) {const deadline = Date.now() + 5000; while (!test()) {assert(Date.now() < deadline, label); await ticks();}}
function ids(memory, prefix) {
    return [...memory.documents.values()].map(value => value.document)
        .filter(value => value.kind === 'manifest' && value.bundle_id.startsWith(prefix)).map(value => value.bundle_id);
}
function retained(memory, index, id) {
    const manifest = memory.documents.get(memory.key(index, id)).document;
    return JSON.parse(Buffer.concat(manifest.chunk_ids.map(chunk =>
        Buffer.from(memory.documents.get(memory.key(index, chunk)).document.payload, 'base64'))).toString());
}
try {
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const sourceFixture = join(repo, 'tests/fixtures/portable-state-worker');
    assert.equal(hash(readFileSync(join(sourceFixture, 'source-1-1480-20261020.tar.gz'))), '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    const extraction = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [join(sourceFixture, 'prepare.py'), join(directory, 'capture')],
        {encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024});
    assert.equal(extraction.status, 0, extraction.stderr);
    const extracted = JSON.parse(extraction.stdout);
    assert.equal(extracted.files, 1488); assert.equal(extracted.bytes, 27982958); assert.equal(extracted.selectedBlocks, 1480);
    assert.equal(hash(readFileSync(extracted.plan)), extracted.planSha256);
    assert.equal(extracted.archiveSha256, '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    const sourceDir = join(directory, 'capture/source'), schemaJson = readFileSync(join(sourceDir, 'schema.json'), 'utf8');
    assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
    const receipt = JSON.parse(readFileSync(join(sourceDir, 'receipt.json'))), frameIndex = new Map(receipt.frames.map(row => [row.blockNum, row]));
    assert.equal(receipt.chainId, chainId); assert.equal(receipt.complete, true);
    const wireRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
    const originalDir = join(wireRoot, 'fixtures/codec/native-onblock-6508-20261022');
    const manifest = JSON.parse(readFileSync(join(originalDir, 'manifest.json')));
    for (const member of manifest.members) {const bytes = readFileSync(join(originalDir, member.path)); assert.equal(bytes.length, member.bytes); assert.equal(hash(bytes), member.sha256);}
    const expected = new Map(JSON.parse(readFileSync(join(originalDir, 'expected.json'))).map(row => [row.blockNum, row]));
    const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
    const fixture = {profileId, handshake: JSON.parse(schemaJson), frameHex: readFileSync(join(sourceDir, 'block-000033.bin')).toString('hex')};
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId},
        eosio_alias: 'sysio', system_contract: 'sysio', index_version: 'v1', index_partition_size: 1000, es_replicas: 0,
        protocol_abi_coordination: {recovery_window_blocks: 256}},
        indexer: {fetch_block: true, fetch_traces: true, fetch_deltas: true, process_deltas: false, disable_indexing: false, live_reader: true},
        features: {contract_console: false, failed_trx: false, streaming: {traces: true, deltas: false}},
        scaling: {ds_pool_size: 1, ds_queues: 1, routing_mode: 'round_robin', indexing_queues: 1, ad_idx_queues: 2},
        whitelists: {root_only: false, actions: [], deltas: []}, blacklists: {actions: [], deltas: []},
        api: {tx_cache_mode: 'batch', disable_tx_cache: false}, plugins: {}};
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: chainId}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json'); process.env.live_mode = 'true'; process.env.worker_role = 'continuous_reader';
    const [{default: Reader}, {default: Main}, {default: Pool}, {default: Parser}, {HyperionModuleLoader}, {loadChainProtocol},
        {ProtocolAbiCoordinator}, {ProtocolAbiCoordinatorRpc}, {ProtocolSourceBindingStore, protocolSourceSelectionHeader},
        {ProtocolAbiObservationStore}, {ProtocolAbiFrontierStore}, {ActionSourceAdmissionStore, actionSourceIngressHeader, actionSourceAdmissionHeader},
        {deriveActionSourceInventory, ActionSourceInventoryError}, {actionHistoryImmutableJson, fingerprintActionHistoryEffect}, {currentActionPolicy, currentActionConfiguration},
        {publishAdmittedActionWithEvidence}] = await Promise.all([
        import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/workers/deserializer.js'),
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/modules/parsers/3.2-parser.js'),
        import('../../build/indexer/modules/loader.js'), import('../../build/indexer/protocol/selection.js'),
        import('../../build/indexer/protocol/abi-coordinator.js'), import('../../build/indexer/protocol/abi-coordinator-rpc.js'),
        import('../../build/indexer/protocol/source-bindings.js'), import('../../build/indexer/protocol/abi-observation-store.js'),
        import('../../build/indexer/protocol/abi-frontier-store.js'), import('../../build/indexer/history/action-source-admission.js'),
        import('../../build/indexer/history/action-source-inventory.js'), import('../../build/indexer/history/action-history-manifest.js'),
        import('../../build/indexer/history/action-producer-epoch.js'), import('../../build/indexer/history/action-confirmed-publication.js')]);
    const installed = await loadChainProtocol(config.settings.protocol);
    assert.ok(installed.provider.nativeActions, 'select the installed native provider normally');
    assert(installed.components.every(component => component.sourceRevision === '7167659e9c043cb3351074fcacb40200cc57f3a3'));
    const selected = installed;
    const wire = await import('@eosrio/hyperion-wire-plugin');
    const codec = wire.createWireValueCodec(fixture.handshake, wire.resolveCodecProfile(profileId));
    const template = codec.decode('result', Buffer.from(fixture.frameHex, 'hex'));
    const memory = frontierMemoryClient(), bindings = new ProtocolSourceBindingStore(memory.client, chain);
    let readStage = 'source-setup'; const measuredReads = []; let observeRead;
    const actualGet = memory.client.get.bind(memory.client);
    memory.client.get = async (request, options) => {
        const measured = {stage: readStage, index: request.index, id: request.id, family: request.id.split(':')[0],
            returnedJsonBytes: 0, errorMetaJsonBytes: 0, succeeded: false};
        measuredReads.push(measured); observeRead?.();
        try {const returned = await actualGet(request, options); measured.returnedJsonBytes = Buffer.byteLength(JSON.stringify(returned));
            measured.succeeded = true; return returned;}
        catch (error) {measured.errorMetaJsonBytes = Buffer.byteLength(JSON.stringify(error?.meta ?? null)); throw error;}
    };
    const observations = new ProtocolAbiObservationStore(memory.client, chain), frontier = new ProtocolAbiFrontierStore(memory.client, chain);
    const admissionStore = new ActionSourceAdmissionStore(memory.client, chain), targetName = `${chain}-action-v1-000001`;
    memory.settings.set(targetName, {'index.uuid': 'owned-wire-admission-target'});
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    const filters = {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()};
    const cm = {config, filters}, parser = new Parser(cm), loader = Object.create(HyperionModuleLoader.prototype);
    Object.assign(loader, {handledActions: new Map(), handledDeltas: new Map(), parser, plugins: []});
    const readerConsumer = new ControlledConsumer(), mainConsumer = new ControlledConsumer(), poolConsumer = new ControlledConsumer();
    const readerPublisher = new ControlledPublisher(), mainPublisher = new ControlledPublisher(), poolPublisher = new ControlledPublisher();
    const worker = (prototype, consumer, publisher) => {
        const value = Object.create(prototype);
        if (prototype === Main.prototype || prototype === Pool.prototype)
            controlledAttemptLifecycle(value, prototype === Pool.prototype ? 'ds_pool_worker' : 'deserializer');
        Object.assign(value, {chain, chainId, conf: config, configModule: cm, filters, mLoader: loader,
            protocol: selected.provider, protocolId: selected.id, protocolComponents: selected.components,
            protocolReady: Promise.resolve(), abieos: selected.decoder, client: memory.client,
            ch: consumer, cch: publisher, ch_ready: true, cch_ready: true, profiler: {start: () => () => {}},
            actionAdmissionOwners: new WeakMap(), actionAdmissionStore: admissionStore});
        Object.defineProperty(value, 'actionSourceAdmissionEnabled', {value: true});
        return value;
    };
    reader = worker(Reader.prototype, readerConsumer, readerPublisher);
    const main = worker(Main.prototype, mainConsumer, mainPublisher), pool = worker(Pool.prototype, poolConsumer, poolPublisher);
    Object.assign(reader, {baseRequest: {}, shipRev: 0, socketGeneration: 0, activeIngressGeneration: 0,
        isLiveReader: true, local_block_num: 0, local_lib: 0, receivedFirstBlock: true,
        reversibleBlockMap: new Map(), forkedBlocks: new Map(), publications: new Map(),
        protocolSourceBindingStore: bindings, send() {}, handleStatusResult() {}});
    reader.stageOneDistQueue = {push: async payload => {
        sourceFrames.push(payload); return new Promise(resolve => reader.distribute([payload], resolve));
    }};
    Object.assign(main, {local_block_count: 0, lastSelectedWorker: 0, dsPoolMap: {}, ds_pool_counters: {}, block_emit_idx: 1,
        protocolDeliveryOwners: new WeakMap(), protocolSourceBindingStore: bindings, protocolAbiObservationStore: observations,
        preIndexingQueue: {push: async payload => blockWrites.push(payload)}});
    Object.assign(pool, {protocolDeliveryOwners: new WeakMap(), poolAbiCache: new Map(), poolTypeCache: new Map(),
        protocolCacheViews: new Set(), temp_ds_counter: 0, actionDsCounter: 0, act_emit_idx: 1, txCacheExpiration: 3600,
        allowStreaming: true, common: {attachActionExtras: Pool.prototype.attachActionExtras},
        pushToActionsQueue() {assert.fail('Wire admitted output bypassed its confirmed publisher');},
        ioRedisClient: {pipeline() {
            const writes = [];
            return {hset(key, values) {writes.push({key, values: new Map([...values].map(([key, value]) => [key, Buffer.from(value)]))}); return this;},
                expire() {return this;}, async exec() {cache.push(...writes); return [];}};
        }}});
    const profile = {id: selected.id, profileId, components: selected.components};
    coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'native-worker-original-owner', bindings, observations, store: frontier,
        verifyNativeGenesis: selected.provider.verifyNativeGenesis.bind(selected.provider), nativeActionInterfaceVersion: 1});
    await coordinator.start();
    reader.coordinatorRpc = new ProtocolAbiCoordinatorRpc((request, callback) => {
        const input = request.data;
        void (input.operation === 'open' ? coordinator.openSource(input.contextId, input.readerSessionId) : coordinator.admit(input.selectionId, input.generation))
            .then(result => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId, data: {ok: true, result}}))
            .catch(error => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId,
                data: {ok: false, error: {code: 'controlled_coordinator', message: error.message}}}));
        callback(null);
    });
    await reader.onMessage(Buffer.from(schemaJson));
    await reader.onMessage(Buffer.from(codec.encode('result', ['get_status_result_v0', {head: template[1].head,
        last_irreversible: {block_num: 0, block_id: blockId(0)}, trace_begin_block: 1, trace_end_block: 2401,
        chain_state_begin_block: 1, chain_state_end_block: 2401, chain_id: chainId}])));
    const prepare = async bytes => {
        const before = readerPublisher.sent.length, mainBefore = mainPublisher.sent.length;
        assert.equal(await reader.onMessage(bytes), 'block'); await ticks();
        assert.equal(readerPublisher.sent.length, before + 1);
        const raw = readerPublisher.sent.at(-1), delivery = message(raw);
        assert.equal(raw.options.mandatory, true); assert.equal(raw.options.persistent, true);
        assert.ok(raw.payload.equals(bytes)); assert.ok(raw.options.headers[actionSourceIngressHeader]);
        const retainedIngress = await admissionStore.resolveIngress(raw.options.headers[actionSourceIngressHeader]);
        assert.equal(retainedIngress.frameHex, bytes.toString('hex'));
        (controlledAttemptLifecycle(main, 'deserializer'), main).captureActionAdmissionDelivery(delivery, mainConsumer); (controlledAttemptLifecycle(main, 'deserializer'), main).captureProtocolSourceDelivery(delivery, mainConsumer);
        await parser.parseMessage(main, [delivery]); await draining;
        assert.equal(mainConsumer.acked.at(-1), delivery);
        const messages = mainPublisher.sent.slice(mainBefore).map(sent => {
            const delivery = message(sent); (controlledAttemptLifecycle(pool, 'ds_pool_worker'), pool).captureActionAdmissionDelivery(delivery, poolConsumer);
            (controlledAttemptLifecycle(pool, 'ds_pool_worker'), pool).captureProtocolActionDelivery(delivery, poolConsumer); return delivery;
        });
        const admissionId = messages[0]?.properties.headers[actionSourceAdmissionHeader];
        // Empty-block links contain no source body; resolve the bounded set by actual retained source association.
        let admission;
        for (const id of admissionId ? [admissionId] : ids(memory, 'h45actionadmission1:')) {
            const value = await admissionStore.resolve(id);
            if (value.source.inventoryInput.source.blockNum === numberFrom(bytes)) {admission = value; break;}
        }
        assert.ok(admission, 'source admission is discoverable after prepare');
        const sourceSelectionId = raw.options.headers[protocolSourceSelectionHeader];
        const link = await bindings.readObservationLink(sourceSelectionId), observation = await observations.read(link.observationId);
        assert.equal(observation.observation.status, numberFrom(bytes) === 1 ? 'native-genesis' : 'observed', JSON.stringify(observation.observation));
        if (numberFrom(bytes) === 1) {
            // Original genesis omits traces. Retain that missing-input boundary, never manufacture an empty vector.
            assert.ok(admission.incomplete); assert.equal(messages.length, 0);
            assert.equal(ids(memory, 'h45actionhandoff1:').length, 0, 'missing original genesis traces cannot be a successful handoff');
            await assert.rejects(pool.getProtocolNativeReader().waitForOpen({chainId, blockNum: 1,
                blockId: admission.source.inventoryInput.source.blockId}, sourceSelectionId), {code: 'native_source_incomplete'});
            return {admission, messages, sourceSelectionId};
        }
        const originalTraces = codec.decode('transaction_trace[]', Buffer.from(codec.decode('result', bytes)[1].traces, 'hex'));
        const expected = deriveActionSourceInventory({profileId, source: admission.source.inventoryInput.source,
            policy: currentActionPolicy(main), traces: originalTraces, wireActionInputs: observation.observation.facts.actionInputs, sourceSelectionId});
        assert.deepEqual(admission.inventory, expected);
        for (const delivery of messages) {
            const transaction = expected.transactions[delivery.properties.headers.action_trace_ordinal];
            assert.equal(delivery.content.toString(), transaction.dispatch.canonicalJson);
        }
        return {admission, messages, sourceSelectionId};
    };
    const numberFrom = bytes => Number(codec.decode('result', bytes)[1].this_block.block_num);
    let original36, disabledScope; const originalControls = new Map();
    for (let height = 1; height <= (workload === 'traces-disabled' ? 33 : 36); height++) {
        if (workload === 'no-effects' && height === 36) {
            filters.action_whitelist.add('sysio::setabi'); filters.action_blacklist.add('sysio::setabi');
        }
        if (workload === 'traces-disabled' && height === 33) {
            config.indexer.fetch_traces = false; mainConsumer.onAck = () => {disabledScope = currentProofConsumerScope(true);};
        }
        const bytes = readFileSync(join(sourceDir, 'block-' + String(height).padStart(6, '0') + '.bin'));
        assert.equal(hash(bytes), frameIndex.get(height).sha256);
        const prepared = await prepare(bytes); originalControls.set(height, prepared); if (height === 36) original36 = prepared;
    }
    if (workload === 'traces-disabled') {
        const selected = originalControls.get(33); assert.equal(selected.messages.length, 0);
        const rows = ids(memory, 'h45actionattempt1:').map(id => JSON.parse(retained(memory, admissionStore.index, id).payloadJson))
            .filter(value => value.work.source.blockNum === 33);
        assert.equal(rows.length, 1); assert.equal(rows[0].disposition, 'operator-disabled'); assert.equal(rows[0].reason, 'traces-disabled');
        assert.equal(rows[0].work.transaction.expectedGroups, 1); assert.deepEqual(rows[0].output, {kind: 'unresolved'});
        assert.equal(disabledScope.snapshot().state, 'drained');
        cases.push({id: 'actual-main-traces-disabled-original-source-root', originalBlock: 33, originalAckInRoot: true,
            expectedGroups: 1, dispatchedTransactions: 0, masterAcceptedEnd: false}); return;
    }
    if (workload === 'no-effects') {
        const selected = original36, transaction = selected.admission.inventory.transactions[1];
        assert.equal(selected.messages.length, 1); assert.equal(transaction.disposition, 'no-effects'); assert.equal(transaction.groups.length, 0);
        assert.equal(selected.messages[0].properties.headers.action_trace_ordinal, 1);
        let scope; poolConsumer.onAck = () => {scope = currentProofConsumerScope(true);};
        await pool.processMessages(selected.messages);
        assert.equal(poolPublisher.sent.length, 0); assert.equal(poolConsumer.acked.length, 1); assert.equal(scope.snapshot().state, 'drained');
        const rows = ids(memory, 'h45actionattempt1:').map(id => JSON.parse(retained(memory, admissionStore.index, id).payloadJson))
            .filter(value => value.work.admissionId === selected.admission.id);
        assert.equal(rows.length, 2); assert(rows.some(value => value.disposition === 'policy-excluded' && value.work.transaction.traceOrdinal === 0));
        assert(rows.some(value => value.disposition === 'no-effects' && value.work.transaction.traceOrdinal === 1 && value.work.transaction.expectedGroups === 0));
        cases.push({id: 'actual-original36-policy-excluded-and-ds-no-effects-roots', originalAckInRoot: true,
            policyExcludedOrdinal: 0, noEffectsOrdinal: 1, expectedGroups: 0, outputCount: 0, masterAcceptedEnd: false}); return;
    }
    const transaction = original36.admission.inventory.transactions[1];
    assert.equal(transaction.transactionId, '140abb3d398f206518e117c02ccf1f1604b37b9fb55f7abed2034cf2fb374c66');
    assert.equal(transaction.groups.length, 2);
    const original = original36.messages.find(value => value.properties.headers.action_trace_ordinal === 1);
    assert.ok(original); assert.equal(original.content.toString(), transaction.dispatch.canonicalJson);
    const deliveries = [101, 102].map(deliveryTag => ({content: Buffer.from(original.content),
        properties: structuredClone(original.properties), fields: {deliveryTag}}));
    assert.notEqual(deliveries[0], deliveries[1]); assert.notEqual(deliveries[0].content, deliveries[1].content);
    for (const delivery of deliveries) {
        pool.captureActionAdmissionDelivery(delivery, poolConsumer); pool.captureProtocolActionDelivery(delivery, poolConsumer);
    }
    const outputsBefore = poolPublisher.sent.length, ackBefore = poolConsumer.acked.length;
    readStage = 'ds-same-cargo';
    await pool.processMessages(deliveries);
    readStage = 'post-ds-audit';
    assert.equal(poolConsumer.acked.length - ackBefore, 2);
    assert.deepEqual(poolConsumer.acked.slice(ackBefore), deliveries);
    const outputs = poolPublisher.sent.slice(outputsBefore).map(sent => ({payloadSha256: hash(sent.payload),
        queue: sent.queue, action: JSON.parse(sent.payload)}));
    assert.equal(outputs.length, 4); assert.deepEqual(outputs.map(row => row.action.act.name), ['setcode','setabi','setcode','setabi']);
    assert(outputs.every(row => row.action.protocol.schemaVersion === 1 && row.action.protocol.status === undefined));
    assert.equal(outputs[0].payloadSha256, outputs[2].payloadSha256); assert.equal(outputs[1].payloadSha256, outputs[3].payloadSha256);
    const summary = new Map();
    for (const row of measuredReads) {
        const key = JSON.stringify([row.stage,row.index,row.family]);
        const value = summary.get(key) ?? {stage: row.stage,index: row.index,family: row.family,getCalls: 0,
            successfulReturnedJsonBytes: 0,failedErrorMetaJsonBytes: 0,failedCalls: 0};
        value.getCalls++; value.successfulReturnedJsonBytes += row.returnedJsonBytes;
        value.failedErrorMetaJsonBytes += row.errorMetaJsonBytes; if (!row.succeeded) value.failedCalls++;
        summary.set(key,value);
    }
    assert.equal(nativeAddonResolutions, 0);
    assert.equal(pool.poolAbiCache.size, 0); assert.equal(pool.poolTypeCache.size, 0);
    assert.equal(pool.protocolCacheViews.size, 0); assert.equal(pool.protocolNativeCacheEntries?.size ?? 0, 0);
    cases.push({id: 'original36-duplicate-cargo-per-delivery-proof-lifetime',
        kind: 'controlled-memory-cache-read-count', originalArchiveSha256: extracted.archiveSha256,
        original36FrameSha256: hash(readFileSync(join(sourceDir, 'block-000036.bin'))), transactionId: transaction.transactionId,
        traceOrdinal: 1, dispatchPayloadSha256: hash(original.content), dispatchHeaders: original.properties.headers,
        deliveryTags: deliveries.map(value => value.fields.deliveryTag), independentPhysicalReceipts: true,
        sameCargo: true, outputNames: outputs.map(row => row.action.act.name), outputPayloadSha256: outputs.map(row => row.payloadSha256),
        acknowledgments: 2, proofBearingCachesAfterCargo: 0, controlledLocalOnly: true, masterAcceptedEnd: false,
        byteDefinition: 'UTF8 JSON.stringify actual successful memory-client.get return object; thrown meta measured separately; excludes network framing',
        summary: [...summary.values()], reads: structuredClone(measuredReads), networkOrThroughputClaim: false});
    if (workload === 'roles') {
    readStage = 'role-lifecycle';
    const records = () => ids(memory, 'h45actionattempt1:').map(id => ({id, value: JSON.parse(retained(memory, admissionStore.index, id).payloadJson)}));
    const manifestIs = (request, family) => request.document.kind === 'manifest' && request.document.bundle_id.startsWith(family + ':');
    let deliveryTag = 1000;
    const start = (selectedWorker, original) => {
        const delivery = {content: Buffer.from(original.content), properties: structuredClone(original.properties), fields: {deliveryTag: ++deliveryTag}};
        const consumer = new ControlledConsumer(), publisher = new ControlledPublisher();
        selectedWorker.ch = consumer; selectedWorker.cch = publisher; selectedWorker.ch_ready = true; selectedWorker.cch_ready = true;
        selectedWorker.captureActionAdmissionDelivery(delivery, consumer);
        if (selectedWorker === main) selectedWorker.captureProtocolSourceDelivery(delivery, consumer);
        else selectedWorker.captureProtocolActionDelivery(delivery, consumer);
        let scope, settled = false;
        observeRead = () => {scope ??= currentProofConsumerScope(true);};
        consumer.onAck = receipt => {assert.equal(receipt, delivery); assert.equal(currentProofConsumerScope(true), scope);};
        const pending = selectedWorker.processMessages([delivery]);
        void pending.then(() => {settled = true;}, () => {settled = true;});
        return {delivery, consumer, publisher, pending, get scope() {return scope;}, get settled() {return settled;}};
    };
    const finished = async run => {
        await run.pending; assert.equal(run.consumer.acked.length, 1); assert.equal(run.consumer.acked[0], run.delivery);
        assert.equal(run.scope.snapshot().state, 'drained'); observeRead = undefined;
    };
    const admitCurrentHandlers = async (height, ordinal) => {
        const source = mainConsumer.acked.find(receipt => hash(receipt.content) === frameIndex.get(height).sha256);
        assert(source); const run = start(main, source); await finished(run);
        const sent = run.publisher.sent.find(value => value.options.headers.action_trace_ordinal === ordinal); assert(sent);
        const admission = await admissionStore.resolve(sent.options.headers[actionSourceAdmissionHeader]);
        assert.equal(admission.source.frameHex, source.content.toString('hex'));
        assert.equal(sent.payload.toString(), admission.inventory.transactions[ordinal].dispatch.canonicalJson);
        return {receipt: message(sent), admission};
    };
    const genesisDelivery = mainConsumer.acked[0];
    const admittedSource = start(main, genesisDelivery); await finished(admittedSource);
    assert.equal(admittedSource.publisher.sent.length, 0);
    const genesisRows = records().filter(row => row.value.work.source.blockNum === 1);
    assert.equal(genesisRows.length, 1); assert.equal(genesisRows[0].value.reason, 'source-traces-missing');
    assert.equal(genesisRows[0].value.work.transaction, null); assert.equal(genesisRows[0].value.work.planId, null);
    cases.push({id: 'actual-main-admitted-original-genesis-honest-incompleteness', originalAckInRoot: true, inventedTransactionOrPlan: false});

    const unbound = {content: Buffer.from(genesisDelivery.content), properties: structuredClone(genesisDelivery.properties)};
    delete unbound.properties.headers[protocolSourceSelectionHeader];
    const beforeCapsule = ids(memory, 'h45srcq1:').length, beforeAttempts = records().length;
    const quarantined = start(main, unbound); await finished(quarantined);
    assert.equal(quarantined.publisher.sent.length, 0); assert.equal(ids(memory, 'h45srcq1:').length, beforeCapsule + 1);
    assert.equal(records().length, beforeAttempts, 'capsule-only source must not invent an admitted inventory or terminal disposition');
    const capsuleIo = new Error('controlled capsule storage rejection');
    memory.faults.beforeWrite = async request => {if (manifestIs(request, 'h45srcq1')) throw capsuleIo;};
    const failedCapsule = start(main, unbound); await assert.rejects(failedCapsule.pending, error => error === capsuleIo);
    assert.equal(failedCapsule.consumer.acked.length, 0); assert.equal(failedCapsule.scope.snapshot().state, 'drained');
    delete memory.faults.beforeWrite; observeRead = undefined;
    cases.push({id: 'actual-main-capsule-only-quarantine-and-failed-write', capsuleBeforeAck: true, inventedInventory: false, failedWriteAcks: 0});

    let uncertainCopies = 0;
    memory.faults.receipt = (receipt, request) => {
        if (!manifestIs(request, 'h45actionattempt1')) return receipt;
        uncertainCopies++; return {...receipt, _shards: {...receipt._shards, successful: 0}};
    };
    const unknown = start(main, genesisDelivery); await assert.rejects(unknown.pending, /acknowledg|shard|copies|durab/i);
    assert.equal(unknown.consumer.acked.length, 0); assert.equal(uncertainCopies, 1); delete memory.faults.receipt;
    let freshCopies = 0;
    memory.faults.receipt = (receipt, request) => {if (manifestIs(request, 'h45actionattempt1')) freshCopies++; return receipt;};
    const repaired = start(main, genesisDelivery); await finished(repaired); assert.equal(freshCopies, 1); delete memory.faults.receipt;
    cases.push({id: 'actual-main-primary-visible-unknown-write-no-ack-fresh-redelivery', uncertainAcks: 0, freshConfiguredCopyReceipts: 1});

    const sourceReceipt36 = mainConsumer.acked.find(receipt => hash(receipt.content) === frameIndex.get(36).sha256);
    assert(sourceReceipt36);
    const heldDispatch = start(main, sourceReceipt36); heldDispatch.publisher.automatic = false; heldDispatch.publisher.writable = false;
    await until(() => heldDispatch.publisher.sent.length === 1, 'actual MainDS reaches a held original DS dispatch confirm');
    heldDispatch.consumer.emit('close'); let physicallyEnded = false;
    const ending = heldDispatch.scope.closeAndDrain().then(end => {physicallyEnded = true; return end;});
    await ticks(); assert.equal(physicallyEnded, false); assert.equal(heldDispatch.consumer.acked.length, 0);
    heldDispatch.publisher.sent[0].confirm(null); await ticks(); assert.equal(physicallyEnded, false);
    heldDispatch.publisher.emit('drain'); await assert.rejects(heldDispatch.pending, /owner|fenced|abort|channel/i);
    assertProofConsumerEnd(heldDispatch.scope, await ending); assert.equal(heldDispatch.consumer.acked.length, 0); observeRead = undefined;
    cases.push({id: 'actual-main-confirm-and-buffer-drain-after-original-channel-fence', newOriginalAcks: 0,
        alreadyDispatchedOutputMayFinish: true, endedAfterConfirmOnly: false, endedAfterConfirmAndDrain: true});

    const invalidOrdinal = {content: Buffer.from(original.content), properties: structuredClone(original.properties)};
    delete invalidOrdinal.properties.headers.action_trace_ordinal;
    const missing = start(pool, invalidOrdinal); await assert.rejects(missing.pending, /ordinal|payload/);
    assert.equal(missing.publisher.sent.length, 0); assert.equal(missing.consumer.acked.length, 0);
    assert.equal(missing.scope.snapshot().state, 'drained'); observeRead = undefined;
    cases.push({id: 'actual-ds-missing-original-ordinal-no-membership', outputCount: 0, acks: 0});

    let retainedHost, retainedPush, retainedCommon, retainedReader, retainedView, hookScope;
    const actualExtras = pool.common.attachActionExtras;
    pool.common.attachActionExtras = async (self, action) => {
        hookScope ??= currentProofConsumerScope(true); retainedHost ??= self;
        retainedPush ??= self.pushToActionsQueue; retainedCommon ??= self.common.attachActionExtras;
        if (!retainedView) {
            retainedReader = self.getProtocolProofReader();
            retainedView = await retainedReader.open({chainId, blockNum: 36, blockId: original36.admission.source.inventoryInput.source.blockId}, original36.sourceSelectionId);
        }
        return actualExtras(self, action);
    };
    const hookOwned = start(pool, original); await finished(hookOwned); pool.common.attachActionExtras = actualExtras;
    assert.equal(hookOwned.publisher.sent.length, 2); assert.equal(hookScope.snapshot().state, 'drained');
    const outputBeforeLate = hookOwned.publisher.sent.length, ackBeforeLate = hookOwned.consumer.acked.length;
    assert.throws(() => retainedHost.getProtocolProofReader(), error => error.code === 'worker_attempt_fenced');
    assert.throws(() => retainedPush({}), error => error.code === 'worker_attempt_fenced');
    assert.throws(() => retainedCommon(pool, {}), error => error.code === 'worker_attempt_fenced');
    await assert.rejects(retainedReader.revalidate(retainedView), error => error.code === 'worker_attempt_fenced');
    assert.equal(hookOwned.publisher.sent.length, outputBeforeLate); assert.equal(hookOwned.consumer.acked.length, ackBeforeLate);
    cases.push({id: 'actual-ds-detached-host-helper-and-issued-view-outside-context', deniedCapabilities: 4, newOutputCount: 0, newAcks: 0});

    loader.handledActions.set('*', new Map([['setcode', async action => {action.receipt[1].recv_sequence = 'invalid-sequence';}]]));
    const contractSelected = await admitCurrentHandlers(36, 1);
    const contract = start(pool, contractSelected.receipt); await finished(contract);
    assert.equal(contract.publisher.sent.length, 0);
    const contractRows = records().filter(row => row.value.work.admissionId === contractSelected.admission.id && row.value.reason === 'contract-finalization-invalid');
    assert.equal(contractRows.length, 1); assert.deepEqual(contractRows[0].value.output, {kind: 'unresolved'});
    cases.push({id: 'actual-ds-contract-finalization-diagnostic-root', originalAckInRoot: true, outputCount: 0, expectedGroups: contractRows[0].value.work.transaction.expectedGroups});
    loader.handledActions.clear();
    const attemptsBeforeHook = records().length;
    loader.handledActions.set('*', new Map([['setcode', async () => {throw new Error('controlled untyped contract hook failure');}]]));
    const genericSelected = await admitCurrentHandlers(36, 1);
    const genericHook = start(pool, genericSelected.receipt); await finished(genericHook);
    assert.equal(genericHook.publisher.sent.length, 0); assert.equal(records().length, attemptsBeforeHook);
    cases.push({id: 'actual-ds-generic-contract-hook-no-fabricated-terminal-cause', originalAckInRoot: true, outputCount: 0});
    loader.handledActions.clear();

    const original33 = originalControls.get(33), nativeOriginal = original33.messages[0];
    assert.equal(original33.admission.source.inventoryInput.source.blockNum, 33);
    loader.handledActions.set('*', new Map([['onblock', async () => {throw new Error('controlled native hook failure');}]]));
    const rawSelected = await admitCurrentHandlers(33, 0);
    const raw = start(pool, rawSelected.receipt); await finished(raw); loader.handledActions.clear();
    assert.equal(raw.publisher.sent.length, 1); const rawValue = JSON.parse(raw.publisher.sent[0].payload);
    assert.equal(rawValue.protocol.schemaVersion, 2); assert.equal(rawValue.protocol.status, 'incomplete');
    const rawRows = records().filter(row => row.value.work.admissionId === rawSelected.admission.id);
    assert(rawRows.some(row => row.value.output.kind === 'raw-incomplete'));
    cases.push({id: 'actual-ds-original-native-raw-incomplete-handoff', originalBlock: 33, originalAckInRoot: true, outputCount: 1});

    config.indexer.disable_indexing = true;
    main.ch = mainConsumer; main.cch = mainPublisher; main.ch_ready = true; main.cch_ready = true;
    const disabledSource = await prepare(readFileSync(join(sourceDir, 'block-000037.bin')));
    const disabled = start(pool, disabledSource.messages[0]); await finished(disabled);
    assert.equal(disabled.publisher.sent.length, 0);
    const disabledRows = records().filter(row => row.value.work.admissionId === disabledSource.admission.id);
    assert(disabledRows.some(row => row.value.disposition === 'operator-disabled'));
    cases.push({id: 'actual-ds-operator-disabled-original-input-root', originalBlock: 37, originalAckInRoot: true, outputCount: 0});
    config.indexer.disable_indexing = false;

    loader.handledActions.set('*', new Map([['setcode', async action => {action.receipt[1].recv_sequence = 'invalid-sequence';}]]));
    const changedSelected = await admitCurrentHandlers(36, 1);
    for (const mutation of ['consumer', 'publisher', 'configuration', 'target']) {
        const held = gate(); let entered = false;
        memory.faults.beforeWrite = async request => {if (manifestIs(request, 'h45actionattempt1')) {entered = true; await held.held;}};
        const changed = start(pool, changedSelected.receipt); await until(() => entered, 'actual held contract disposition ' + mutation);
        assert.equal(changed.settled, false); assert.equal(changed.consumer.acked.length, 0);
        const oldConsole = config.features.contract_console, oldUuid = memory.settings.get(targetName)['index.uuid'];
        if (mutation === 'consumer') pool.ch = new ControlledConsumer();
        if (mutation === 'publisher') pool.cch = new ControlledPublisher();
        if (mutation === 'configuration') config.features.contract_console = !oldConsole;
        if (mutation === 'target') memory.settings.get(targetName)['index.uuid'] = 'controlled-replacement';
        held.release(); await assert.rejects(changed.pending, /owner|channel|epoch|target/i);
        assert.equal(changed.consumer.acked.length, 0); assert.equal(changed.scope.snapshot().state, 'drained');
        config.features.contract_console = oldConsole; memory.settings.get(targetName)['index.uuid'] = oldUuid;
        delete memory.faults.beforeWrite; observeRead = undefined;
        cases.push({id: 'actual-ds-' + mutation + '-across-held-disposition-write', alreadyDispatchedWriteMayFinish: true, acks: 0});
    }
    loader.handledActions.clear();
    const following = start(pool, nativeOriginal); await finished(following); assert.equal(following.publisher.sent.length, 1);
    cases.push({id: 'actual-ds-unrelated-following-input-progress', originalBlock: 33, outputCount: 1, originalAckInRoot: true});
    loader.handledActions.set('*', new Map([['setcode', async action => {action.receipt[1].recv_sequence = 'invalid-sequence';}]]));
    const revokedSelected = await admitCurrentHandlers(36, 1), revokeGate = gate(); let revokeEntered = false;
    memory.faults.beforeWrite = async request => {if (manifestIs(request, 'h45actionattempt1')) {revokeEntered = true; await revokeGate.held;}};
    const revoked = start(pool, revokedSelected.receipt); await until(() => revokeEntered, 'actual contract disposition held across source revocation');
    assert.equal(revoked.settled, false); assert.equal(revoked.consumer.acked.length, 0);
    assert.equal(await coordinator.revokeSource(reader.sourceContext.readerSessionId), true);
    revokeGate.release(); await assert.rejects(revoked.pending, error => error.statusCode === 503);
    assert.equal(revoked.consumer.acked.length, 0); assert.equal(revoked.publisher.sent.length, 0);
    assert.equal(revoked.scope.snapshot().state, 'drained'); delete memory.faults.beforeWrite; observeRead = undefined;
    loader.handledActions.clear();
    cases.push({id: 'actual-wire-source-revocation-across-held-contract-write', alreadyDispatchedWriteMayFinish: true, newOutputCount: 0, acks: 0});
    }

} catch (error) {
    console.log(JSON.stringify({qualificationFailedAfter: cases.map(value => value.id)})); throw error;
} finally {
    reader?.coordinatorRpc?.cancel(); reader?.shipSession?.close?.();
    process.send = previousSend; process.chdir(previousDirectory); hooks.deregister();
    const ownedDirectory = resolve(directory); assert.equal(dirname(ownedDirectory), resolve(tmpdir()));
    assert.match(basename(ownedDirectory), /^hyperion-attempt-worker-original-/); rmSync(ownedDirectory, {recursive: true, force: true});
}
}

/** Real ProjectionWorker initialization entry with controlled readiness/connect/exit seams. */
async function projectionInitializationFence() {
    const previousDirectory = process.cwd(), previousConfig = process.env.CONFIG_JSON, previousExit = process.exit;
    const directory = mkdtempSync(join(tmpdir(), 'hyperion-attempt-projection-init-'));
    mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
    const definition = {schemaVersion: 1, id: 'items', mappingRevision: 'a'.repeat(64),
        source: {contract: 'items', table: 'items', abiDeployment: 'constructed-epoch', abiSha256: 'b'.repeat(64)},
        fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};
    const conf = {settings: {chain: 'projection-init'}, indexer: {live_reader: true}, whitelists: {}, blacklists: {},
        features: {portable_state: {backend: {kind: 'mongodb', id: 'fixture-backend', database: 'fixture'}, projections: [definition]}}};
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(conf)); process.env.CONFIG_JSON = join(directory, 'chain.json'); process.chdir(directory);
    const {default: ProjectionWorker} = await import('../../build/indexer/workers/projection.js');
    const {HyperionWorker} = await import('../../build/indexer/workers/hyperionWorker.js');
    const worker = Object.create(ProjectionWorker.prototype), readiness = gate(), entered = gate(), exits = [];
    let scope, connects = 0, reportsStopped = 0, ending, work;
    const controlledExit = new Error('controlled worker process.exit observation');
    Object.assign(worker, {chainId, conf, protocolId: 'constructed-initialization-only', protocolReady: readiness.promise,
        protocol: {profileId: 'constructed-initialization-only', verifyNativeGenesis() {}},
        manager: {conn: {mongodb: {}}, mongodbClient: {async connect() {connects++; throw new Error('unexpected post-fence connect dispatch');}}},
        profiler: {stopReporting() {reportsStopped++;}},
        runProjectionAttempt(kind, metadata, operation) {
            return HyperionWorker.prototype.runProjectionAttempt.call(this, kind, metadata, async () => {
                scope = currentProofConsumerScope(true); entered.release(); return operation();
            });
        }});
    worker.installControlledAttemptLifecycle('projection');
    process.exit = code => {exits.push(code); throw controlledExit;};
    try {
        work = worker.run(); work.catch(() => {}); await entered.promise;
        let ended = false; ending = scope.closeAndDrain().then(end => {ended = true; return end;});
        await turn(); assert.equal(ended, false, 'actual initialization root still owns its readiness wait');
        readiness.release(); await assert.rejects(work, error => error === controlledExit); assertProofConsumerEnd(scope, await ending);
        assert.equal(connects, 0, 'actual fenced projection initialization cannot dispatch a fresh Mongo connection after readiness returns');
        assert.deepEqual(exits, [1]); assert.equal(reportsStopped, 1);
        cases.push({id: 'actual-projection-worker-initialization-readiness-fence', newConnectionDispatches: connects,
            controlledReadinessConnectAndExitOnly: true, masterAcceptedEnd: false});
    } finally {
        readiness.release(); await Promise.allSettled([work, ending]); worker.workerAttemptClient.dispose(); process.exit = previousExit;
        process.chdir(previousDirectory); if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
        const owned = resolve(directory); assert.equal(dirname(owned), resolve(tmpdir())); assert.match(basename(owned), /^hyperion-attempt-projection-init-/);
        rmSync(owned, {recursive: true, force: true});
    }
}
/** Actual host helper and controlled ES transport; a dispatched creation may finish after fencing. */
async function targetContinuationFences() {
    const previousDirectory = process.cwd(), previousConfig = process.env.CONFIG_JSON;
    const directory = mkdtempSync(join(tmpdir(), 'hyperion-attempt-target-'));
    mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
    const conf = {settings: {chain: 'controlled-target', index_partition_size: 1000, index_version: 'v1'},
        indexer: {}, features: {}, whitelists: {}, blacklists: {}};
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(conf)); process.env.CONFIG_JSON = join(directory, 'chain.json'); process.chdir(directory);
    const {HyperionWorker} = await import('../../build/indexer/workers/hyperionWorker.js');
    try {
        for (const boundary of ['exists', 'create']) {
            const entered = gate(), held = gate(), effects = [], worker = Object.create(HyperionWorker.prototype);
            Object.assign(worker, {chain: 'controlled-target', conf, client: {indices: {
                async exists() {effects.push('exists'); if (boundary === 'exists') {entered.release(); await held.promise;} return false;},
                async create({index}) {effects.push('create'); if (boundary === 'create') {entered.release(); await held.promise;}
                    return {acknowledged: true, shards_acknowledged: true, index};},
                async getSettings({index}) {effects.push('getSettings'); return {[index]: {settings: {'index.uuid': 'controlled-target-uuid'}}};},
            }}});
            const scope = new ProofConsumerScope('actual-target-held-' + boundary); let retainedTarget, ending;
            const work = scope.run(() => {retainedTarget = worker.scopedHookWorker().actionTarget; return retainedTarget(1, true);}); work.catch(() => {});
            try {
                await entered.promise; const dispatched = [...effects]; let ended = false;
                ending = scope.closeAndDrain().then(end => {ended = true; return end;}); await turn(); assert.equal(ended, false);
                held.release(); await assert.rejects(work, error => error.code === 'worker_attempt_fenced');
                assertProofConsumerEnd(scope, await ending);
                assert.deepEqual(effects, dispatched, 'a fenced actual target continuation cannot dispatch new target creation/settings after held ' + boundary);
                assert.throws(() => retainedTarget(1, true), error => error.code === 'worker_attempt_fenced'); assert.deepEqual(effects, dispatched);
                cases.push({id: 'actual-target-post-' + boundary + '-fence', dispatchedBeforeFence: dispatched,
                    newTransportCallsAfterFence: [], originalOperationActuallyDrained: true, controlledElasticsearchTransport: true});
            } finally {held.release(); await Promise.allSettled([work, ending]);}
        }
    } finally {
        process.chdir(previousDirectory); if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
        const owned = resolve(directory); assert.equal(dirname(owned), resolve(tmpdir())); assert.match(basename(owned), /^hyperion-attempt-target-/);
        rmSync(owned, {recursive: true, force: true});
    }
}

/** Constructed protocol source, actual coordinator replacement and unchanged default public ancestry. */
async function canonicalForkAndApiExpiry() {
    const fork = await nativeFixture(), scope = new ProofConsumerScope('actual-canonical-replacement');
    const native = fork.reader(fork.proofs(true)); let grant;
    await scope.run(async () => {
        const view = await native.open(fork.selected.source, fork.selected.selectionId);
        const decision = await native.authorize(view, fork.input); assert.equal(decision.kind, 'native'); grant = decision.grant;
    });
    try {
        const replacement = await fork.append(2, 'f'.repeat(64)), beforeDecode = fork.calls.decode;
        await assert.rejects(native.decodeValue(grant), error => error.statusCode === 503 && error.code !== 'worker_attempt_fenced');
        assert.equal(scope.snapshot().state, 'open'); assert.equal(fork.calls.decode, beforeDecode);
        const current = fork.reader(fork.proofs(false)), view = await current.open(replacement.source, replacement.selectionId);
        const currentDecision = await current.authorize(view, fork.input); assert.equal(currentDecision.kind, 'native');
        assert.deepEqual(await current.decodeValue(currentDecision.grant), {rawHex: '0102'});
        cases.push({id: 'actual-canonical-fork-revokes-original-native-grant', constructedProtocolSource: true,
            oldScopeStillOpen: true, newlyAuthorizedOldCodecCalls: 0, replacementSourceUsable: true});
    } finally {assertProofConsumerEnd(scope, await scope.closeAndDrain());}

    const fixture = await nativeFixture(), publicReader = fixture.proofs(false), managedReader = fixture.proofs(true);
    const active = new ProofConsumerScope('active-internal-census-does-not-pin-public-reader'), held = gate(), entered = gate();
    const root = active.run(async () => {
        await managedReader.open(fixture.selected.source, fixture.selected.selectionId); entered.release(); await held.promise;
    });
    try {
        await entered.promise;
        for (let height = 3; height <= 258; height++) await fixture.append(height);
        assert((await publicReader.open(fixture.selected.source, fixture.selected.selectionId)).source.blockNum === 2);
        await fixture.append(259);
        await assert.rejects(publicReader.open(fixture.selected.source, fixture.selected.selectionId), {code: 'ancestry_unavailable'});
        await assert.rejects(active.operation(() => managedReader.open(fixture.selected.source, fixture.selected.selectionId)), {code: 'ancestry_unavailable'});
        assert.equal(active.snapshot().state, 'open');
        cases.push({id: 'default256-public-open-ancestry-unchanged-with-active-internal-root', constructedProtocolSource: true,
            allowedDistance: 256, deniedDistance: 257, internalCensusPinsPublicReader: false});
    } finally {held.release(); await root; assertProofConsumerEnd(active, await active.closeAndDrain());}
}

/** Actual MainDS and real retained stores; constructed host codec, controlled method-return gates, no canonical grant. */
async function sourceContinuationFences() {
    const previousDirectory = process.cwd(), previousConfig = process.env.CONFIG_JSON, previousSend = process.send;
    const directory = mkdtempSync(join(tmpdir(), 'hyperion-attempt-source-continuation-'));
    mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
    const conf = {settings: {chain: 'source-continuation', es_replicas: 0}, indexer: {}, features: {}, whitelists: {}, blacklists: {}};
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(conf)); process.env.CONFIG_JSON = join(directory, 'chain.json'); process.chdir(directory);
    const [{default: Main}, {protocolSourceCapture}, {ProtocolSourceBindingReadError, protocolSourceSelectionHeader}] = await Promise.all([
        import('../../build/indexer/workers/deserializer.js'), import('../../build/indexer/workers/hyperionWorker.js'),
        import('../../build/indexer/protocol/source-bindings.js')]);
    const observations = [];
    try {
        for (const schedule of ['ready', 'selection-reject', 'selection-success', 'abi-prepare', 'observation-link', 'native-prepare',
            'abi-prepare-reject', 'observation-link-reject', 'native-prepare-reject', 'codec-rejection', 'selection-reject-unfenced', 'codec-reject-unfenced']) {
            const effects = [], memory = frontierMemoryClient(), held = gate(), entered = gate(), rootEntered = gate();
            const bindings = new ProtocolSourceBindingStore(memory.client, conf.settings.chain), abi = new ProtocolAbiObservationStore(memory.client, conf.settings.chain);
            const native = new ProtocolNativeObservationStore(memory.client, conf.settings.chain), worker = Object.create(Main.prototype);
            const schemaJson = '{"fixture":"controlled-source-continuations"}'; let scope, fenceIndex, ending, sessionCloses = 0;
            const result = ['get_blocks_result_v0', {this_block: {block_num: 2, block_id: blockId(2)}, prev_block: {block_num: 1, block_id: blockId(1)},
                head: {block_num: 2, block_id: blockId(2)}, last_irreversible: {block_num: 0, block_id: blockId(0)},
                block: '00', traces: Buffer.from('[]').toString('hex'), deltas: Buffer.from('[]').toString('hex')}];
            const frame = Buffer.from(JSON.stringify(result)), capture = protocolSourceCapture(chainId, result[1], schemaJson);
            const context = await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson});
            const selection = await bindings.prepareSelection({schemaVersion: 1, contextId: context.id, readerSessionId: 'controlled-source-continuation',
                readerRole: 'bulk', assignmentId: null, source: capture.source, frameSha256: hash(frame), captureSha256: capture.captureSha256,
                head: {blockNum: 2, blockId: blockId(2)}, irreversible: {blockNum: 0, blockId: blockId(0)}});
            const channel = new EventEmitter(); channel.ack = () => effects.push('ack');
            const message = {content: Buffer.from(frame), properties: {headers: {[protocolSourceSelectionHeader]: selection.id}}, fields: {deliveryTag: 1}};
            const provider = {profileId: profile.profileId, createShipSession() {
                effects.push('session-create'); return {
                    decodeResult(bytes) {
                        effects.push('decode-result');
                        if (schedule === 'codec-rejection') {fenceIndex = effects.length; scope.fence(); entered.release(); throw new Error('controlled synchronous codec rejection');}
                        if (schedule === 'codec-reject-unfenced') throw new Error('controlled unfenced codec rejection');
                        return JSON.parse(Buffer.from(bytes).toString());
                    },
                    decodeTraces(bytes) {effects.push('decode-traces'); return JSON.parse(Buffer.from(bytes).toString());},
                    decodeDeltas(bytes) {effects.push('decode-deltas'); return JSON.parse(Buffer.from(bytes).toString());},
                    close() {sessionCloses++;},
                };
            }, observeBlockAbi() {effects.push('observe-abi'); return {schemaVersion: 1, actionInputs: [], deployments: [], finalStates: []};},
                nativeActions: {interfaceVersion: 1, observe() {effects.push('observe-native'); return {schemaVersion: 1, decisions: []};}}};
            Object.assign(worker, {chain: conf.settings.chain, chainId, conf, client: memory.client,
                ch: channel, cch: new EventEmitter(), ch_ready: true, cch_ready: true, protocolReady: schedule === 'ready' ? held.promise : Promise.resolve(),
                protocolId: profile.id, protocol: provider, protocolComponents: profile.components, profiler: {start: () => () => {}},
                protocolDeliveryOwners: new WeakMap(), protocolSourceBindingStore: bindings, protocolAbiObservationStore: abi, protocolNativeObservationStore: native});
            worker.installControlledAttemptLifecycle('deserializer'); worker.captureProtocolSourceDelivery(message, channel);
            const readSelection = bindings.readSelection.bind(bindings);
            bindings.readSelection = async id => {
                effects.push('read-selection'); const value = await readSelection(id);
                if (schedule === 'selection-reject-unfenced') throw new ProtocolSourceBindingReadError('missing', 'selection', id, 'controlled original read result rejected');
                if (schedule === 'selection-reject' || schedule === 'selection-success') {entered.release(); await held.promise;}
                if (schedule === 'selection-reject') throw new ProtocolSourceBindingReadError('missing', 'selection', id, 'controlled held original read result rejected');
                return value;
            };
            const quarantine = bindings.quarantine.bind(bindings);
            bindings.quarantine = (...args) => {effects.push('quarantine'); return quarantine(...args);};
            for (const [object, method, boundary] of [[abi, 'prepare', 'abi-prepare'], [bindings, 'prepareObservationLink', 'observation-link'], [native, 'prepare', 'native-prepare']]) {
                const actual = object[method].bind(object);
                object[method] = async (...args) => {
                    effects.push(boundary); const value = await actual(...args);
                    if (schedule === boundary || schedule === boundary + '-reject') {entered.release(); await held.promise;}
                    if (schedule === boundary + '-reject') throw new Error('controlled original ' + boundary + ' return rejected');
                    return value;
                };
            }
            process.send = event => {if (event.event === 'protocol_abi_prepared') effects.push('prepare-hint'); return true;};
            const work = worker.runWorkerAttemptDelivery(message, () => {
                scope = currentProofConsumerScope(true); rootEntered.release();
                return worker.processProtocolSourceDelivery(message, async decoded => {
                    effects.push('process-bound');
                    if (schedule.includes('prepare') || schedule.includes('observation-link')) await worker.prepareProtocolAbiObservations(decoded);
                });
            }); work.catch(() => {});
            try {
                const unfenced = schedule.endsWith('-unfenced');
                if (unfenced) {
                    await work; assert.equal(effects.filter(value => value === 'quarantine').length, 1); assert.equal(effects.filter(value => value === 'ack').length, 1);
                    observations.push({schedule, unfencedClassificationPreserved: true, quarantineWrites: 1, originalAckAttempts: 1});
                } else {
                    if (schedule === 'ready') await rootEntered.promise; else await entered.promise;
                    fenceIndex ??= effects.length; let ended = false;
                    ending = scope.closeAndDrain().then(end => {ended = true; return end;});
                    if (schedule !== 'codec-rejection') {await turn(); assert.equal(ended, false, 'held original source continuation must drain honestly');}
                    held.release(); const outcome = await Promise.allSettled([work]); assertProofConsumerEnd(scope, await ending);
                    assert.equal(effects.includes('ack'), false);
                    observations.push({schedule, dispatchedBeforeFence: effects.slice(0, fenceIndex), newCallsAfterFence: effects.slice(fenceIndex),
                        rootStatus: outcome[0].status, sessionCloses, originalAckAttempts: 0});
                }
            } finally {held.release(); await Promise.allSettled([work, ending]); worker.workerAttemptClient.dispose();}
        }
        console.log(JSON.stringify({sourceContinuationSchedules: observations}));
        assert.deepEqual(observations.filter(value => value.newCallsAfterFence?.length).map(value => ({schedule: value.schedule, newCalls: value.newCallsAfterFence})), [],
            'fenced actual MainDS must not dispatch new quarantine, decode, sequential PREPARE/link/native work or hints after held returns');
        for (const observed of observations) cases.push({id: 'actual-main-source-continuation-' + observed.schedule, ...observed,
            constructedHostCodecAndControlledMethodReturns: true, actualRetainedStores: true, canonicalGrantIssued: false, masterAcceptedEnd: false});
    } finally {
        process.send = previousSend; process.chdir(previousDirectory); if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
        const owned = resolve(directory); assert.equal(dirname(owned), resolve(tmpdir())); assert.match(basename(owned), /^hyperion-attempt-source-continuation-/);
        rmSync(owned, {recursive: true, force: true});
    }
}

const mode = process.argv[2] ?? 'scope';
if (mode === 'scope') {await reentrantRootClosure(); await reentrantOperationClosure();}
else if (mode === 'snapshot') await callerSourceSnapshot();
else if (mode === 'end-identity') await reentrantAbortEndIdentity();
else if (mode === 'proof') {
    await retainedViewsAndNativeClone(); await heldReadThroughNativeClone();
    await heldReadThroughNativeClone('timeout'); await retainedNativeReadDuringClose();
}
else if (mode === 'publication') {
    await publicationPhysicalDrain(); await publicationPhysicalDrain('timeout');
    await publicationPhysicalDrain('abort', 'close'); await retainedPublicationTicketClosure();
}
else if (mode === 'wire-cache') await originalWireRoles();
else if (mode === 'wire-roles') await originalWireRoles('roles');
else if (mode === 'wire-no-effects') await originalWireRoles('no-effects');
else if (mode === 'wire-traces-disabled') await originalWireRoles('traces-disabled');
else if (mode === 'projection') await projectionRoles();
else if (mode === 'projection-fence') await projectionRoles('revalidation');
else if (mode === 'projection-admission-fence') await projectionRoles('admission');
else if (mode === 'projection-init-fence') await projectionInitializationFence();
else if (mode === 'fork-and-expiry') await canonicalForkAndApiExpiry();
else if (mode === 'target') await targetContinuationFences();
else if (mode === 'source-continuations') await sourceContinuationFences();
else assert.fail('unsupported lifecycle case');
console.log(JSON.stringify({passed: true, mode, native: process.version, cases,
    controlledIO: true, capacityAuthority: false, fullWorkerQualification: false}));
