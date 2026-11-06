/** Actual master callback and native reader identities; RPC and handover inputs are controlled. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.versions.bun, undefined);
assert.match(process.version, /^v(?:24|26)\./);
const requestedScenario = process.argv[2] ?? 'replace-anchor', postRpc = requestedScenario.startsWith('post-'),
    reversibleObservation = requestedScenario.startsWith('post-reversible-');
const scenario = reversibleObservation ? requestedScenario.slice('post-reversible-'.length) : postRpc ? requestedScenario.slice(5) : requestedScenario;
const twoStage = ['advanced-regress', 'advanced-conflict', 'advance-twice', 'advanced-refresh'].includes(scenario);
const successful = ['unchanged', 'advance-anchor', 'advance-block', 'refresh-block', 'offline',
    'source-steady-block', 'source-advance-block', 'coordinator-advance-block', 'advance-twice', 'advanced-refresh'].includes(scenario);
assert.ok(successful || ['replace-anchor', 'replace-block', 'retire-block', 'disconnect-block',
    'withdraw-block', 'regress-block', 'conflict-block', 'shutdown-block', 'unlisted-block',
    'source-replaced-block', 'source-revoked-block', 'source-generation-block', 'source-missing-initial',
    'coordinator-fork-block', 'coordinator-revoked-block', 'advanced-regress', 'advanced-conflict'].includes(scenario));
if (postRpc) assert.ok(!twoStage && scenario !== 'source-missing-initial', 'post-RPC scope control needs a completed original observation');
const until = async (test, label) => {
    const deadline = performance.now() + 5000;
    while (!test()) {assert.ok(performance.now() < deadline, label); await delay(5);}
};

if (cluster.isWorker) {
    const keepAlive = setInterval(() => {}, 1000);
    process.on('message', message => {
        if (message?.event === 'fixture_finish') {clearInterval(keepAlive); process.exit(0);}
    });
    process.send({event: 'fixture_ready', pid: process.pid});
} else {
    const [{HyperionMaster}, {WorkerAttemptSupervisor}, {APIClient, Checksum256, UInt32}, {ProtocolAbiCoordinator},
        {ProtocolAbiFrontierStore}, {ProtocolSourceBindingStore}, {ProtocolAbiObservationStore, protocolAbiCaptureDigest},
        {frontierMemoryClient}] = await Promise.all([
        import('../../build/indexer/modules/master.js'), import('../../build/indexer/protocol/worker-attempt-supervisor.js'),
        import('@wharfkit/antelope'), import('../../build/indexer/protocol/abi-coordinator.js'),
        import('../../build/indexer/protocol/abi-frontier-store.js'), import('../../build/indexer/protocol/source-bindings.js'),
        import('../../build/indexer/protocol/abi-observation-store.js'), import('./protocol-frontier-memory.mjs'),
    ]);
    const bytes = readFileSync(new URL('../fixtures/wire-rpc-block-33.json', import.meta.url));
    assert.equal(bytes.length, 1031);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), '2fbe2a135ad825e5105843dfc0c31bbd8017c15e6b1d2ca9c973be90fd7ecc95');
    const original = JSON.parse(bytes.toString());
    const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
    cluster.setupPrimary({exec: fileURLToPath(import.meta.url), args: [scenario], silent: true});
    const readers = [], supervisor = new WorkerAttemptSupervisor();
    let result, releaseFork, pendingCoordinator;
    const releaseRpc = [];
    try {
        for (let index = 0; index < 2; index++) {
            const worker = cluster.fork(), state = {ready: false, exited: false, code: null, signal: null, stderr: ''};
            readers.push({worker, state}); worker.process.stdout.resume();
            worker.process.stderr.on('data', bytes => {state.stderr += bytes.toString(); assert.ok(state.stderr.length <= 32768);});
            worker.on('message', message => {if (message?.event === 'fixture_ready') {
                assert.equal(message.pid, worker.process.pid); state.ready = true;
            }});
            worker.on('exit', (code, signal) => Object.assign(state, {exited: true, code, signal: signal ?? null}));
        }
        await until(() => readers.every(value => value.state.ready), 'owned native reader identities start');
        const [first, replacement] = readers;
        assert.notEqual(first.worker.process.pid, replacement.worker.process.pid);
        let calls = 0, held = false, secondHeld = false, release, releaseSecond;
        const gate = new Promise(resolve => {release = resolve; releaseRpc.push(resolve);});
        const secondGate = new Promise(resolve => {releaseSecond = resolve; releaseRpc.push(resolve);});
        const heldCall = reversibleObservation || twoStage || scenario.endsWith('-anchor') || scenario === 'offline' ? 1 : 2;
        const rpc = new APIClient({provider: {async call(args) {
            assert.equal(args.path, '/v1/chain/get_block'); assert.equal(args.params.block_num_or_id, 33);
            calls++;
            if (calls === heldCall) {held = true; await gate;}
            else if (twoStage && calls === 2) {secondHeld = true; await secondGate;}
            return {status: 200, headers: {}, text: bytes.toString(), json: structuredClone(original)};
        }}});
        rpc.v1.chain.get_info = async () => ({head_block_num: UInt32.from(40), last_irreversible_block_num: UInt32.from(reversibleObservation ? 32 : 33),
            chain_id: Checksum256.from(chainId)});
        const master = Object.assign(Object.create(HyperionMaster.prototype), {rpc, esClient: {},
            chain: 'canonical-reader-fixture', conf: {settings: {es_replicas: 0}, indexer: {live_reader: scenario !== 'offline'}},
            shutdownStarted: false, liveReader: {wref: first.worker},
            workerMap: [{wref: first.worker, worker_role: 'continuous_reader'}],
            actionCanonicalLib: scenario === 'offline' ? undefined : {worker: first.worker,
                blockNum: reversibleObservation ? 32 : 33, blockId: reversibleObservation ? original.previous : original.id}});
        let coordinatorFixture;
        if (reversibleObservation || scenario.startsWith('source-') || scenario.startsWith('coordinator-')) {
            // Separately constructed provider inputs; real stores/coordinator own all control receipts.
            // This local fence is not a native source certificate or Wire fork qualification.
            const memory = frontierMemoryClient(), schemaJson = '{"version":"eosio::abi/1.1"}';
            const profile = {id: 'constructed-source', profileId: 'controlled-source-v1', components: [
                {id: 'constructed-provider', runtime: 'node', version: '0.0.0-dev.1', sourceRevision: 'a'.repeat(40), sha256: 'b'.repeat(64)}]};
            const bindings = new ProtocolSourceBindingStore(memory.client, 'canonical-reader-fixture');
            const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson})).id;
            const coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'controlled-master', bindings,
                observations: new ProtocolAbiObservationStore(memory.client, 'canonical-reader-fixture'),
                store: new ProtocolAbiFrontierStore(memory.client, 'canonical-reader-fixture')});
            await coordinator.start();
            const session = 'controlled-session-one', generation = (await coordinator.openSource(contextId, session)).generation;
            const select = async (identity, blockNum = 1, previousBlockId = null) => {
                const source = {chainId, blockNum, blockId: identity.toString(16).padStart(64, '0'), previousBlockId};
                const capture = {kind: 'unattested-ship-result-sections-v1', schemaJson, blockHex: '00', tracesHex: '00', deltasHex: '00'};
                return (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: session, readerRole: 'live', assignmentId: null,
                    source, captureSha256: protocolAbiCaptureDigest(source, capture),
                    frameSha256: createHash('sha256').update('controlled-frame-' + identity).digest('hex'),
                    head: {blockNum, blockId: source.blockId}, irreversible: {blockNum: 0, blockId: '0'.repeat(64)}})).id;
            };
            master.protocolAbiCoordinator = coordinator;
            if (scenario !== 'source-missing-initial') master.protocolAbiSource = {worker: first.worker, readerSessionId: session, generation};
            coordinatorFixture = {coordinator, select, session, generation};
            if (scenario === 'coordinator-fork-block' || scenario === 'coordinator-advance-block')
                assert.equal((await coordinator.admit(await select(1), generation)).status, 'accepted');
        }
        const authority = master.attemptAdjudicatorFor(supervisor).current;
        const pending = authority.canonicalBlock(33); let settled = false;
        void pending.then(() => {settled = true;}, () => {settled = true;});
        await until(() => held || settled, 'the actual master waits for its original RPC observation or refuses unavailable source');
        if (scenario !== 'source-missing-initial') assert.equal(held, true);
        let observation;
        if (postRpc) {
            release(); observation = await pending;
            assert.equal(observation.irreversible, !reversibleObservation);
            authority.assertCanonicalCurrent(observation);
            assert.throws(() => authority.assertCanonicalCurrent(structuredClone(observation)), /Unissued canonical action observation/);
        }
        if (twoStage) {
            master.actionCanonicalLib = {worker: first.worker, blockNum: 34, blockId: '00000022' + 'e'.repeat(56)};
            release();
            await until(() => secondHeld || settled, 'the master accepts the first advance and starts its second block read');
            assert.equal(secondHeld, true, 'the first observed same-owner LIB advance is valid');
            if (scenario === 'advanced-regress') master.actionCanonicalLib = {worker: first.worker, blockNum: 33, blockId: original.id};
            else if (scenario === 'advanced-conflict') master.actionCanonicalLib = {worker: first.worker, blockNum: 34, blockId: '00000022' + 'f'.repeat(56)};
            else if (scenario === 'advance-twice') master.actionCanonicalLib = {worker: first.worker, blockNum: 35, blockId: '00000023' + 'e'.repeat(56)};
            else master.actionCanonicalLib = {...master.actionCanonicalLib};
            releaseSecond();
        } else if (scenario.startsWith('replace') || scenario === 'retire-block') {
            first.worker.send({event: 'fixture_finish'});
            await until(() => first.state.exited, 'original physical reader exits before RPC completes');
            assert.equal(first.state.code, 0);
            if (scenario.startsWith('replace')) {
                master.liveReader.wref = replacement.worker;
                master.workerMap = [{wref: replacement.worker, worker_role: 'continuous_reader'}];
                master.actionCanonicalLib = {worker: replacement.worker, blockNum: 33, blockId: '00000021' + 'f'.repeat(56)};
            }
        } else if (scenario === 'disconnect-block') {
            first.worker.disconnect(); await until(() => !first.worker.isConnected(), 'original reader IPC disconnects');
            assert.equal(first.state.exited, false, 'disconnected physical reader is still alive');
        } else if (scenario === 'withdraw-block') master.actionCanonicalLib = undefined;
        else if (scenario === 'regress-block') master.actionCanonicalLib = {worker: first.worker, blockNum: 32, blockId: original.previous};
        else if (scenario === 'conflict-block') master.actionCanonicalLib = {worker: first.worker, blockNum: 33, blockId: '00000021' + 'f'.repeat(56)};
        else if (scenario === 'shutdown-block') master.shutdownStarted = true;
        else if (scenario === 'unlisted-block') master.workerMap = [];
        else if (scenario === 'source-replaced-block') master.protocolAbiSource = {
            worker: first.worker, readerSessionId: 'controlled-session-two', generation: 'controlled-generation-two'};
        else if (scenario === 'source-revoked-block') master.protocolAbiSource = undefined;
        else if (scenario === 'source-generation-block') master.protocolAbiSource.generation = 'controlled-generation-two';
        else if (scenario === 'coordinator-revoked-block') {
            await coordinatorFixture.coordinator.revokeSource(coordinatorFixture.session, coordinatorFixture.generation);
        } else if (scenario === 'coordinator-advance-block') {
            const {coordinator, select, generation} = coordinatorFixture;
            assert.equal((await coordinator.admit(await select(2, 2, '1'.padStart(64, '0')), generation)).status, 'accepted');
        } else if (scenario === 'coordinator-fork-block') {
            const {coordinator, select, generation} = coordinatorFixture;
            let recovering = false;
            const forkGate = new Promise(resolve => {releaseFork = resolve;});
            const recover = coordinator.recoverParent.bind(coordinator);
            coordinator.recoverParent = async (...args) => {recovering = true; await forkGate; return recover(...args);};
            pendingCoordinator = coordinator.admit(await select(10), generation); void pendingCoordinator.catch(() => {});
            await until(() => recovering, 'actual coordinator durably fences fork before returning its new generation');
            assert.equal(master.protocolAbiSource.generation, generation, 'master still awaits the coordinator reply');
        }
        else if (scenario.includes('advance')) {
            // Constructed ordinary LIB advance, not a captured fork or new canonical proof.
            master.actionCanonicalLib = {worker: first.worker, blockNum: 34, blockId: '00000022' + 'e'.repeat(56)};
        } else if (scenario === 'refresh-block') master.actionCanonicalLib = {...master.actionCanonicalLib};
        release();
        if (postRpc) {
            if (successful) authority.assertCanonicalCurrent(observation);
            else assert.throws(() => authority.assertCanonicalCurrent(observation), /Current live SHIP irreversible anchor|no longer current/);
        } else if (successful) assert.deepEqual(await pending, {chainId, blockId: original.id, previousBlockId: original.previous, irreversible: true});
        else await assert.rejects(pending, /Current live SHIP irreversible anchor/,
            'an old RPC completion must not authorize a retired or changed physical reader');
        assert.equal(calls, reversibleObservation ? 1 : scenario === 'source-missing-initial' ? 0
            : scenario === 'offline' || !successful && scenario.endsWith('-anchor') ? 1 : 2);
        result = {passed: true, scenario: requestedScenario, native: process.version, actualMasterCallback: true, nativeReaderIdentities: true,
            postRpcFenceChecked: postRpc,
            reversibleObservation,
            staleCompletionRejected: !successful, controlledRpcAndHandover: true, controlledSourceLifecycle: true,
            capacityAuthority: false, fullWorkerQualification: false};
    } finally {
        const cleanupErrors = [];
        for (const release of releaseRpc) release();
        releaseFork?.();
        if (pendingCoordinator) {
            try {await pendingCoordinator;} catch (error) {cleanupErrors.push(String(error));}
        }
        for (const {worker, state} of readers) if (!state.exited) {
            try {
                if (worker.isConnected()) worker.send({event: 'fixture_finish'}); else worker.process.kill('SIGTERM');
                try {await until(() => state.exited, 'owned native identity fixture cleanup');}
                catch {worker.process.kill('SIGTERM'); await until(() => state.exited, 'owned native identity fallback cleanup');}
            } catch (error) {cleanupErrors.push(String(error));}
        }
        supervisor.stop();
        assert.deepEqual(cleanupErrors, []);
        for (const {state} of readers) assert.equal(state.stderr, '');
    }
    console.log(JSON.stringify(result));
}
