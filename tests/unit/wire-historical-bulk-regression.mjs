import {controlledAttemptLifecycle} from './worker-attempt-fixture.mjs';
/** Original Wire frames through emitted reader/MainDS/DS/admission and the normal installed native provider.
 * Public admission remains disabled;
 * broker confirms, cache and ES transports are controlled. No live-service or consensus qualification. */
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let nativeAddonResolutions = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) {nativeAddonResolutions++; throw new Error('Wire admission resolved the Antelope native addon');}
    return next(specifier, context);
}});
const repoUrl=new URL('../../',import.meta.url);
const previousDirectory = process.cwd(), previousSend = process.send;
const workspaceOut=join(fileURLToPath(repoUrl),'out');mkdirSync(workspaceOut,{recursive:true});
const directory = mkdtempSync(join(workspaceOut, 'hyperion-attempt-worker-original-'));
const chain = 'handoff-worker-original', chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d', blockId = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const mode = process.argv[2] ?? 'lifecycle';
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
    sent = [];
    sendToQueue(queue,payload,options){this.sent.push({queue,payload:Buffer.from(payload),options:structuredClone(options)});return true;}
    async prefetch() {}
    async consume(_queue,callback) {this.deliver=callback;}
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
    const repo = fileURLToPath(repoUrl);
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
    const wireRoot = dirname(dirname(fileURLToPath(new URL('node_modules/@eosrio/hyperion-wire-plugin/dist/protocol-provider.json',repoUrl))));
    const originalDir = join(wireRoot, 'fixtures/codec/native-onblock-6508-20261022');
    const manifest = JSON.parse(readFileSync(join(originalDir, 'manifest.json')));
    for (const member of manifest.members) {const bytes = readFileSync(join(originalDir, member.path)); assert.equal(bytes.length, member.bytes); assert.equal(hash(bytes), member.sha256);}
    const expected = new Map(JSON.parse(readFileSync(join(originalDir, 'expected.json'))).map(row => [row.blockNum, row]));
    const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
    const fixture = {profileId, handshake: JSON.parse(schemaJson), frameHex: readFileSync(join(sourceDir, 'block-000033.bin')).toString('hex')};
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId},
        eosio_alias: 'sysio', system_contract: 'sysio', index_version: 'v1', index_partition_size: 1000, es_replicas: 0,
        protocol_abi_coordination: {recovery_window_blocks: 256, historical_certificates: {interface_version:1,max_commits_per_drain:2,max_commit_bytes_per_drain:1048576,max_ms_per_drain:1000}}},
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
        import(new URL('build/indexer/workers/state-reader.js',repoUrl)), import(new URL('build/indexer/workers/deserializer.js',repoUrl)),
        import(new URL('build/indexer/workers/ds-pool.js',repoUrl)), import(new URL('build/indexer/modules/parsers/3.2-parser.js',repoUrl)),
        import(new URL('build/indexer/modules/loader.js',repoUrl)), import(new URL('build/indexer/protocol/selection.js',repoUrl)),
        import(new URL('build/indexer/protocol/abi-coordinator.js',repoUrl)), import(new URL('build/indexer/protocol/abi-coordinator-rpc.js',repoUrl)),
        import(new URL('build/indexer/protocol/source-bindings.js',repoUrl)), import(new URL('build/indexer/protocol/abi-observation-store.js',repoUrl)),
        import(new URL('build/indexer/protocol/abi-frontier-store.js',repoUrl)), import(new URL('build/indexer/history/action-source-admission.js',repoUrl)),
        import(new URL('build/indexer/history/action-source-inventory.js',repoUrl)), import(new URL('build/indexer/history/action-history-manifest.js',repoUrl)),
        import(new URL('build/indexer/history/action-producer-epoch.js',repoUrl)), import(new URL('build/indexer/history/action-confirmed-publication.js',repoUrl))]);
    const installed = await loadChainProtocol(config.settings.protocol);
    assert.ok(installed.provider.nativeActions, 'select the installed native provider normally');
    assert(installed.components.every(component => component.sourceRevision === '1e7547ff52740ecaa88d7867d3ec887a2febaa58'));
    config.prefetch ??= {block: 1};
    const selected = installed;
    const wire = await import(new URL('node_modules/@eosrio/hyperion-wire-plugin/dist/index.js',repoUrl));
    const codec = wire.createWireValueCodec(fixture.handshake, wire.resolveCodecProfile(profileId));
    const template = codec.decode('result', Buffer.from(fixture.frameHex, 'hex'));
    const memory = frontierMemoryClient(), bindings = new ProtocolSourceBindingStore(memory.client, chain);
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
        verifyNativeGenesis: selected.provider.verifyNativeGenesis.bind(selected.provider), nativeActionInterfaceVersion: 1,historicalCertificates:{interfaceVersion:1,maxCommitsPerDrain:2,maxCommitBytesPerDrain:1048576,maxMillisecondsPerDrain:1000}});
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
    delete pool.pushToActionsQueue;
    assert.equal(reader.actionSourceAdmissionEnabled,false);assert.equal(main.actionSourceAdmissionEnabled,false);assert.equal(pool.actionSourceAdmissionEnabled,false);
    const prepareNormal=async bytes=>{
        const before=readerPublisher.sent.length, mainBefore=mainConsumer.sent.length;
        assert.equal(await reader.onMessage(bytes),'block');await ticks();assert.equal(readerPublisher.sent.length,before+1);
        const raw=readerPublisher.sent.at(-1), delivery=message(raw);assert.ok(raw.payload.equals(bytes));
        const sourceSelectionId=raw.options.headers[protocolSourceSelectionHeader];assert.ok(sourceSelectionId);
        (controlledAttemptLifecycle(main,'deserializer'),main).captureProtocolSourceDelivery(delivery,mainConsumer);
        await parser.parseMessage(main,[delivery]);await draining;assert.equal(mainConsumer.acked.at(-1),delivery);
        return {sourceSelectionId,messages:mainConsumer.sent.slice(mainBefore).map(message)};
    };
    let prepared,livePrepared;
    for(let number=1;number<=288;number++){
        const bytes=readFileSync(join(sourceDir,'block-'+String(number).padStart(6,'0')+'.bin'));
        if(number===31){reader.isLiveReader=false;prepared=await prepareNormal(bytes);reader.isLiveReader=true;livePrepared=await prepareNormal(bytes);}
        else await prepareNormal(bytes);
    }
    for(let k=0;k<160;k++)await coordinator.drain();
    const historyControl=await coordinator.inspect();assert.equal(historyControl.head.blockNum,288);assert.equal(historyControl.head.coverageStart,1);assert.ok(historyControl.historical);
    const before=poolConsumer.acked.length,queued=prepared.messages.length;assert.equal(queued,1);
    const {ProtocolAbiProofReader}=await import(new URL('build/indexer/protocol/abi-proof.js',repoUrl));
    const witnessReader=new ProtocolAbiProofReader({chainId,profile,store:frontier.asReadOnly(),maxAncestryBlocks:256,historicalCertificates:true});
    const canonicalSource={chainId,blockNum:31,blockId:codec.decode('result',readFileSync(join(sourceDir,'block-000031.bin')))[1].this_block.block_id};
    const canonicalProof=await witnessReader.open(canonicalSource,livePrepared.sourceSelectionId);
    assert.equal(canonicalProof.selectionId,livePrepared.sourceSelectionId);
    await assert.rejects(()=>witnessReader.open({...canonicalSource,blockId:'f'.repeat(64)},livePrepared.sourceSelectionId),e=>e.code==='source_not_canonical');
    await assert.rejects(()=>witnessReader.open(canonicalSource,prepared.sourceSelectionId),e=>e.code==='source_not_canonical');
    const candidate=await bindings.readSelection(prepared.sourceSelectionId),canonical=await bindings.readSelection(livePrepared.sourceSelectionId);
    assert.notEqual(prepared.sourceSelectionId,livePrepared.sourceSelectionId);
    assert.deepEqual(candidate.selection.source,canonical.selection.source);
    assert.equal(candidate.selection.captureSha256,canonical.selection.captureSha256);
    assert.equal(candidate.selection.frameSha256,canonical.selection.frameSha256);
    assert.equal(candidate.selection.contextId,canonical.selection.contextId);
    console.log(JSON.stringify({control:'actual-canonical-proof-and-wrong-fork', canonical:true,wrongForkRejected:true,distinctSelections:true,sameSource:true,sameCapture:true,sameFrame:true}));
    const partialStore=new ProtocolAbiFrontierStore(memory.client,chain+'-partial');
    const partial=new ProtocolAbiCoordinator({chainId,profile,ownerId:'partial-source-owner',bindings,observations,store:partialStore,
        verifyNativeGenesis:selected.provider.verifyNativeGenesis.bind(selected.provider),nativeActionInterfaceVersion:1,
        historicalCertificates:{interfaceVersion:1,maxCommitsPerDrain:2,maxCommitBytesPerDrain:1048576,maxMillisecondsPerDrain:1000}});
    await partial.start();const openedPartial=await partial.openSource(canonical.selection.contextId,canonical.selection.readerSessionId);
    assert.equal((await partial.admit(livePrepared.sourceSelectionId,openedPartial.generation)).status,'accepted');
    for(let i=0;i<5;i++)await partial.drain();const partialControl=await partial.inspect();
    assert.equal(partialControl.head.coverageStart,31);assert.ok(!partialControl.historical);
    const partialReader=new ProtocolAbiProofReader({chainId,profile,store:partialStore.asReadOnly(),maxAncestryBlocks:256,historicalCertificates:true});
    await assert.rejects(()=>partialReader.openHistorical(31,{source:canonicalSource,selectionId:livePrepared.sourceSelectionId}));
    console.log(JSON.stringify({control:'actual-partial-coverage',coverageStart:partialControl.head.coverageStart,historicalRoot:false}));
    const tampered=message(readerPublisher.sent.find(x=>x.options.headers[protocolSourceSelectionHeader]===prepared.sourceSelectionId));tampered.content[0]^=1;const beforeTamper=mainConsumer.sent.length;
    (controlledAttemptLifecycle(main,'deserializer'),main).captureProtocolSourceDelivery(tampered,mainConsumer);
    await parser.parseMessage(main,[tampered]);assert.equal(mainConsumer.sent.length,beforeTamper);
    assert.ok(events.some(e=>e.event==='ds_error'&&e.data?.type==='protocol_source_incomplete'&&e.data?.code==='protocol_source_invalid'));
    console.log(JSON.stringify({control:'changed-original-frame',quarantined:true,downstreamPublications:0}));
    if(mode==='disabled')delete config.settings.protocol_abi_coordination.historical_certificates;
    pool.consumerQueue=pool.createConsumerQueue();pool.local_queue='wire:ds_pool:1';await pool.initConsumer();
    const started=Date.now();let finished;poolConsumer.deliver(prepared.messages[0]);const drained=pool.consumerQueue.drain().then(()=>{finished=Date.now();});await new Promise(resolve=>setTimeout(resolve,100));const pendingAfter100ms=poolConsumer.acked.length===before;await drained;
    const elapsed=finished-started,settled=poolConsumer.acked.length-before;assert.equal(settled,1);
    const diagnostic=events.find(e=>e.event==='ds_error'&&e.data?.type==='protocol_action_incomplete'&&e.data?.blockNum===31);
    const output=poolConsumer.sent.map(x=>JSON.parse(x.payload.toString()));
    if(mode==='disabled'){assert.ok(output.length>0);assert.ok(output.every(x=>x.protocol?.status==='incomplete'));console.log(JSON.stringify({control:'historical-disabled',dsAck:settled,incomplete:output.length}));}
    else {
    const {ProtocolActionConsumer}=await import(new URL('build/api/helpers/protocol-abi.js',repoUrl));
    const host={manager:{chain,conn:{chains:{[chain]:{chain_id:chainId}}},config},elastic:memory.client};const api=new ProtocolActionConsumer(host,selected);host.protocolActionConsumer=api;
    const disabledConfig=structuredClone(config);delete disabledConfig.settings.protocol_abi_coordination.historical_certificates;const disabledHost={manager:{chain,conn:{chains:{[chain]:{chain_id:chainId}}},config:disabledConfig},elastic:memory.client};const disabledApi=new ProtocolActionConsumer(disabledHost,selected);await assert.rejects(()=>disabledApi.reader.open(canonicalSource,prepared.sourceSelectionId),e=>e.code==='ancestry_unavailable');
    const apiProof=await api.reader.open(canonicalSource,prepared.sourceSelectionId);assert.equal(apiProof.selectionId,prepared.sourceSelectionId);
    const metadata=output[0].protocol;assert.equal(metadata.selectionId,prepared.sourceSelectionId);assert.equal(metadata.schemaVersion,2);
    const apiNative=await api.nativeReader.open(canonicalSource,prepared.sourceSelectionId);const decision=await api.nativeReader.authorize(apiNative,metadata.input);
    assert.equal(decision.kind,'native');assert.deepEqual(await api.nativeReader.metadata(decision.grant),metadata);
    const {protectProtocolAction}=await import(new URL('build/api/helpers/protocol-abi.js',repoUrl));
    const served=structuredClone(output[0]);await protectProtocolAction(host,{},served,{decode:true});assert.deepEqual(served.protocol,metadata);
    await assert.rejects(()=>api.nativeReader.authorize(apiNative,{...metadata.input,receiptAbiSequence:String(BigInt(metadata.input.receiptAbiSequence)+1n)}));
    const aborted=new AbortController();aborted.abort();await assert.rejects(()=>api.reader.open(canonicalSource,prepared.sourceSelectionId,{signal:aborted.signal}));
    const falseSelection=structuredClone(candidate.selection);falseSelection.captureSha256='f'.repeat(64);
    const falseId=(await bindings.prepareSelection(falseSelection)).id;const ownLink=await bindings.readObservationLink(prepared.sourceSelectionId);
    await bindings.prepareObservationLink({...ownLink,selectionId:falseId});
    await assert.rejects(()=>api.reader.open(canonicalSource,falseId),e=>e.code==='source_not_canonical');
    const missingId=(await bindings.prepareSelection({...candidate.selection,readerSessionId:'missing-retained-link'})).id;
    await assert.rejects(()=>api.reader.open(canonicalSource,missingId),e=>e.code==='missing'&&e.recordType==='observation-link');
    console.log(JSON.stringify({control:'independent-api-reader',requestedSelectionRetained:true,nativeMetadataMatches:true,alteredCaptureRejected:true}));
    for(const mutate of [control=>{control.historical=null;},control=>{control.historical.anchor.coverageStart=2;}]){
        memory.faults.read=(result,request)=>{if(request.index!==frontier.controlIndex||request.id!=='control')return result;
            const doc=structuredClone(result._source),control=JSON.parse(Buffer.from(doc.payload,'base64').toString());mutate(control);
            const bytes=Buffer.from(JSON.stringify(control));doc.payload=bytes.toString('base64');doc.digest=hash(bytes);return {...result,_source:doc};};
        await assert.rejects(()=>api.reader.revalidate(apiProof));delete memory.faults.read;await api.reader.revalidate(apiProof);
    }
    console.log(JSON.stringify({control:'historical-root-revoked-or-partial',rejected:true}));
    const controlBefore=await coordinator.inspect();const delayed=gate();let entered;const entering=new Promise(resolve=>entered=resolve);let holdOnce=true;
    memory.faults.beforeRead=async request=>{if(holdOnce&&request.index===bindings.index){holdOnce=false;entered();await delayed.held;}};
    const pendingRevalidation=api.reader.open(canonicalSource,prepared.sourceSelectionId);await entering;
    assert.equal(await coordinator.revokeSource(controlBefore.source.readerSessionId,controlBefore.generation),true);delayed.release();
    await assert.rejects(pendingRevalidation);delete memory.faults.beforeRead;
    await assert.rejects(()=>witnessReader.revalidate(canonicalProof));await assert.rejects(()=>api.reader.revalidate(apiProof));await assert.rejects(()=>api.nativeReader.revalidate(apiNative));
    console.log(JSON.stringify({control:'actual-source-revocation',oldProofRejected:true}));
    console.log(JSON.stringify({control:'observed-actual-bulk',dsAck:settled,output:output.map(x=>({block_num:x.block_num,protocolStatus:x.protocol?.status,ds_error:x.ds_error??false})),diagnostic:diagnostic?.data.message}));assert.ok(output.length>0);assert.ok(output.every(x=>x.protocol?.status!=='incomplete'),'equivalent original bulk capture should decode with the certified canonical source');
    console.log(JSON.stringify({test:'warm-live-frame-advances',admissionEnabled:false,bulkSourceSelection:prepared.sourceSelectionId,liveSourceSelection:livePrepared.sourceSelectionId,coordinatorHead:(await coordinator.inspect()).head.blockNum,diagnostic:diagnostic?.data.message,mainPublished:queued,dsAck:settled,elapsedMs:elapsed,actionPublished:output.length,output:output.map(x=>({block_num:x.block_num,protocolStatus:x.protocol?.status,ds_error:x.ds_error??false})),historicalRoot:true,defaultAncestry:256,controlledBroker:true}));

    }
} finally {
    reader?.coordinatorRpc?.cancel(); reader?.shipSession?.close?.();
    process.send = previousSend; process.chdir(previousDirectory); hooks.deregister();
    const ownedDirectory = resolve(directory); assert.equal(dirname(ownedDirectory), resolve(workspaceOut));
    assert.match(basename(ownedDirectory), /^hyperion-attempt-worker-original-/); rmSync(ownedDirectory, {recursive: true, force: true});
}
