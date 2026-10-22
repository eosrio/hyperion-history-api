import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {registerHooks} from 'node:module';
import {validateProtocolNativeActions} from '@eosrio/hyperion-sdk/protocol';
import {createWireNativeActions,resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';
import {loadChainProtocol} from '../../build/indexer/protocol/selection.js';
import {ProtocolAbiCoordinator} from '../../build/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiProofReader} from '../../build/indexer/protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest} from '../../build/indexer/protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {ProtocolNativeObservationStore} from '../../build/indexer/protocol/native-observation-store.js';
import {ProtocolNativeActionReader} from '../../build/indexer/protocol/native-authorization.js';
import {protocolNativeInputInventory,snapshotProtocolNativeDecisions} from '../../build/indexer/protocol/native-observation-facts.js';
import {deriveProtocolActionInputs} from '../../build/indexer/history/action-source-inventory.js';
import {protocolBytes} from '../../build/indexer/protocol/contract-cache.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// This is an internal engineering capability. Installed descriptors/providers stay inactive.
registerHooks({resolve(specifier,context,next){if(specifier.includes('node-abieos'))throw new Error('Wire imported legacy addon');return next(specifier,context);}});
const hash=value=>createHash('sha256').update(value).digest('hex');
const repo=fileURLToPath(new URL('../../',import.meta.url)),fixture=join(repo,'tests/fixtures/portable-state-worker');
const wireRoot=dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
const originals=join(wireRoot,'fixtures/codec/native-onblock-6508-20261022');
const originalManifestBytes=readFileSync(join(originals,'manifest.json')),originalManifest=JSON.parse(originalManifestBytes);
assert.equal(hash(readFileSync(join(fixture,'source-1-1480-20261020.tar.gz'))),'42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
assert.equal(hash(readFileSync(join(fixture,'manifest.json'))),'fa48079240a25d6fddfe80b83539bf0735be0f03b034dd816205c7e815d2d305');
for(const member of originalManifest.members){const bytes=readFileSync(join(originals,member.path));assert.equal(bytes.length,member.bytes);assert.equal(hash(bytes),member.sha256);}
const expected=JSON.parse(readFileSync(join(originals,'expected.json'))),targets=new Map(expected.map(row=>[row.blockNum,row]));
const chainId='9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d',chain='native-authority-wire-fixture';
const directory=mkdtempSync(join(tmpdir(),'hapi-native-authority-wire-'));
let session,coordinator,cleanup=false;
try {
    const prepared=spawnSync(process.platform==='win32'?'python':'python3',[join(fixture,'prepare.py'),join(directory,'capture')],
        {encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
    assert.equal(prepared.status,0,prepared.stderr);const extraction=JSON.parse(prepared.stdout);
    assert.equal(extraction.files,1488);assert.equal(extraction.bytes,27982958);
    const sourceDir=join(directory,'capture/source'),schemaJson=readFileSync(join(sourceDir,'schema.json'),'utf8');
    assert.equal(hash(schemaJson),'94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
    const receipt=JSON.parse(readFileSync(join(sourceDir,'receipt.json'))),frameIndex=new Map(receipt.frames.map(row=>[row.blockNum,row]));
    assert.equal(receipt.complete,true);assert.equal(receipt.chainId,chainId);assert.equal(receipt.start,1);assert.equal(receipt.endExclusive,2401);
    const selected=await loadChainProtocol({provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:originalManifest.profileId});
    assert.equal(selected.provider.nativeActions,undefined);
    assert(selected.components.every(component=>component.sourceRevision==='7167659e9c043cb3351074fcacb40200cc57f3a3'));
    const descriptor=JSON.parse(readFileSync(join(wireRoot,'dist/protocol-provider.json')));
    const legacyProfiles=['wire-sysio-6508c9e8-engineering-v1','wire-sysio-7dede884-engineering-v1'].map(id=>{
        const profile=descriptor.profiles.find(profile=>profile.id===id);assert(profile);return profile;
    });
    assert(legacyProfiles.every(profile=>!Object.hasOwn(profile,'nativeActions')));
    const native=validateProtocolNativeActions(createWireNativeActions(resolveCodecProfile(originalManifest.profileId)),{interfaceVersion:1});
    assert.equal(native.valid,true);
    const provider={...selected.provider,nativeActions:native.nativeActions};
    const profile={id:selected.id,profileId:provider.profileId,components:selected.components};
    const memory=frontierMemoryClient(),client=memory.client;
    const bindings=new ProtocolSourceBindingStore(client,chain),observations=new ProtocolAbiObservationStore(client,chain);
    const frontier=new ProtocolAbiFrontierStore(client,chain),journal=new ProtocolNativeObservationStore(client,chain);
    const proofReader=new ProtocolAbiProofReader({chainId,profile,store:frontier});
    const reader=new ProtocolNativeActionReader({chainId,profile,provider,store:journal,proofReader});
    const contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson})).id;
    coordinator=new ProtocolAbiCoordinator({chainId,profile,ownerId:'wire-native-authority-owner',store:frontier,bindings,observations,
        verifyNativeGenesis:provider.verifyNativeGenesis.bind(provider)});
    await coordinator.start();let {generation}=await coordinator.openSource(contextId,'wire-original-prefix');
    session=provider.createShipSession(JSON.parse(schemaJson));
    const selectedSources=new Map(),grants=new Map(),results=[];let parent=null,nativeNotifications=0,notifications=0;
    const makeNativeRecord=(retained,abi,inputs)=>({schemaVersion:1,kind:'observation',nativeInterfaceVersion:1,contextId,protocol:profile,
        source:retained.source,captureRef:{abiObservationId:abi.id,abiObservationDigest:abi.digest,inputSha256:retained.captureSha256},
        inventory:protocolNativeInputInventory(inputs),observation:{status:'observed',facts:snapshotProtocolNativeDecisions(native.nativeActions.observe(
            {schemaJson,block:Buffer.from(retained.capture.blockHex,'hex'),traces:Buffer.from(retained.capture.tracesHex,'hex')},retained.source),inputs)}});
    for(let number=1;number<=397;number++){
        const frame=readFileSync(join(sourceDir,'block-'+String(number).padStart(6,'0')+'.bin')),original=frameIndex.get(number);
        assert.equal(frame.length,original.bytes);assert.equal(hash(frame),original.sha256);
        const decoded=session.decodeResult(frame);assert.equal(decoded[0],'get_blocks_result_v0');const res=decoded[1];
        const position={chainId,blockNum:Number(res.this_block.block_num),blockId:res.this_block.block_id.toString(),previousBlockId:res.prev_block?.block_id.toString()??null};
        assert.equal(position.blockNum,number);assert.equal(position.blockId,original.blockId);assert.equal(position.previousBlockId,parent);
        const section=value=>value===null||value===undefined?null:Buffer.from(protocolBytes(value)).toString('hex');
        const capture={kind:'unattested-ship-result-sections-v1',schemaJson,blockHex:section(res.block),tracesHex:section(res.traces),deltasHex:section(res.deltas)};
        const retained={source:position,capture,captureSha256:protocolAbiCaptureDigest(position,capture)};
        const header=session.decodeBlock(Buffer.from(capture.blockHex,'hex'));
        if(number===1)assert.equal(header.previous,'0'.repeat(64));else assert.equal(header.previous,parent);
        const accountRows=[];let ordinal=0;
        for(const [,delta] of session.decodeDeltas(Buffer.from(capture.deltasHex,'hex')))for(const row of delta.rows){
            if(delta.name==='account'){const raw=protocolBytes(row.data);accountRows.push({ordinal,present:row.present===true||row.present===1,raw,value:session.decodeRow('account',raw)});}
            ordinal++;
        }
        let observation,inputs=[];
        if(number===1){
            assert.equal(capture.tracesHex,null);
            observation={status:'native-genesis',facts:provider.verifyNativeGenesis({schemaJson,block:Buffer.from(capture.blockHex,'hex'),traces:null,deltas:Buffer.from(capture.deltasHex,'hex')},position)};
        }else{
            const traces=session.decodeTraces(Buffer.from(capture.tracesHex,'hex'));
            inputs=deriveProtocolActionInputs(traces);observation={status:'observed',facts:provider.observeBlockAbi({traces,accountRows},position)};
        }
        const selectionId=(await bindings.prepareSelection({schemaVersion:1,contextId,source:position,readerSessionId:'wire-original-prefix',readerRole:'live',assignmentId:null,
            frameSha256:hash(frame),captureSha256:retained.captureSha256,
            head:{blockNum:Number(res.head.block_num),blockId:res.head.block_id.toString()},
            irreversible:{blockNum:Number(res.last_irreversible.block_num),blockId:res.last_irreversible.block_id.toString()}})).id;
        const abiRecord={schemaVersion:1,protocol:profile,source:{...position,inputSha256:retained.captureSha256},capture,observation};
        const abi=await observations.prepare(abiRecord);
        await bindings.prepareObservationLink({schemaVersion:1,selectionId,observationId:abi.id,observationDigest:abi.digest});
        const notification=inputs.find(input=>input.receiver!==input.account);
        if(targets.has(number)||notification||number===34||number===35){
            const nativeRecord=makeNativeRecord(retained,abi,inputs);
            if(number===34){
                const changed=structuredClone(nativeRecord),decision=changed.observation.facts.decisions.find(value=>value.kind==='native');
                assert(decision);assert.equal(notification,undefined);
                changed.observation.facts.decisions[changed.observation.facts.decisions.indexOf(decision)]={origin:decision.origin,kind:'contract'};
                await journal.prepare(selectionId,changed);
            }else if(number===35){
                assert.equal(notification,undefined);nativeRecord.inventory=null;
                nativeRecord.observation={status:'incomplete',error:{code:'engineering_negative_control',message:'Explicit unavailable native source extraction'}};
                await journal.prepare(selectionId,nativeRecord);
            }else await journal.prepare(selectionId,nativeRecord);
            if(targets.has(number))await assert.rejects(reader.open(position,selectionId),error=>['source_pending','authority_unavailable'].includes(error.code));
        }
        const admission=await coordinator.admit(selectionId,generation);assert.equal(admission.status,'accepted');generation=admission.generation;
        assert.deepEqual(await coordinator.drain(),{committed:1,pending:0});
        const control=await coordinator.inspect();assert.equal(control.head.blockNum,number);assert.equal(control.head.coverageStart,1);
        if(number===34)await assert.rejects(reader.open(position,selectionId),{code:'native_source_mismatch'});
        if(number===35)await assert.rejects(reader.open(position,selectionId),{code:'native_source_incomplete'});
        if(number===140||number===141)selectedSources.set(number,{source:position,selectionId});
        if(number===1){const view=await proofReader.open(position,selectionId);assert.deepEqual(await proofReader.nativeGenesisFrame(view),
            {chainId,block:{blockNum:1,blockId:position.blockId,previousBlockId:'0'.repeat(64)},changes:[]});}
        if(targets.has(number)){
            assert.deepEqual(frame,readFileSync(join(originals,'block-'+String(number).padStart(6,'0')+'.bin')));
            const row=targets.get(number),input=inputs.find(input=>input.transactionId===row.transactionId&&input.actionOrdinal===row.actionOrdinal);
            assert(input);assert.equal(input.rawHex,row.rawHex);assert.equal(input.globalSequence,row.globalSequence);
            const view=await reader.open(position,selectionId),authorization=await reader.authorize(view,input);
            assert.equal(authorization.kind,'native');assert.deepEqual(await reader.decodeValue(authorization.grant),row.expectedValue);
            assert.deepEqual(Buffer.from(native.nativeActions.encodeValue(row.nativeKind,row.expectedValue)),Buffer.from(row.rawHex,'hex'));
            const proof=await proofReader.open(position,selectionId),resolved=await proofReader.action(proof,input);
            const deployed=provider.contractCodec.decodeAbi(Buffer.from(resolved.state.abiHex,'hex'));
            assert.throws(()=>provider.contractCodec.decodeValue(deployed,'onblock',Buffer.from(input.rawHex,'hex')),error=>
                error.message===row.originalContractCodecError&&error.code===(number===122?'unsupported_feature':'invalid_value'));
            const unavailableAbi=new Error('Account ABI storage unavailable'),originalFault=memory.faults.beforeRead;
            memory.faults.beforeRead=request=>{if(request.id.startsWith('h45abist1:'))throw unavailableAbi;};
            const independent=await reader.open(position,selectionId),independentGrant=await reader.authorize(independent,input);
            assert.deepEqual(await reader.decodeValue(independentGrant.grant),row.expectedValue);
            await assert.rejects(proofReader.action(proof,input),error=>error===unavailableAbi);memory.faults.beforeRead=originalFault;
            await assert.rejects(reader.authorize({...view},input),{code:'native_invalid_view'});
            await assert.rejects(reader.authorize(view,{...input,rawHex:input.rawHex+'00'}),{code:'native_input_mismatch'});
            await assert.rejects(reader.decodeValue({...authorization.grant}),{code:'native_invalid_grant'});
            selectedSources.set(number,{source:position,selectionId,input,view});grants.set(number,authorization.grant);
            results.push({blockNum:number,blockId:position.blockId,rawSha256:hash(Buffer.from(input.rawHex,'hex')),nativeKind:row.nativeKind,strictDeployedCodecError:row.originalContractCodecError});
        }
        if(notification){
            const view=await reader.open(position,selectionId),origin=inputs.find(input=>input.transactionId===notification.transactionId&&input.actionOrdinal===notification.inputActionOrdinal);
            assert(origin);const first=await reader.authorize(view,origin),inherited=await reader.authorize(view,notification);
            assert.equal(inherited.kind,first.kind);notifications++;
            if(inherited.kind==='native'){assert.deepEqual(await reader.decodeValue(inherited.grant),await reader.decodeValue(first.grant));nativeNotifications++;}
        }
        parent=position.blockId;
    }
    assert.equal(results.length,3);
    for(const number of [33,122]){const target=selectedSources.get(number);await assert.rejects(reader.open(target.source,target.selectionId),{code:'ancestry_unavailable'});}
    const boundary=selectedSources.get(141);assert.equal((await proofReader.open(boundary.source,boundary.selectionId)).source.blockNum,141);
    const outside=selectedSources.get(140);await assert.rejects(proofReader.open(outside.source,outside.selectionId),{code:'ancestry_unavailable'});
    const current=selectedSources.get(397),abort=new AbortController(),reason=Object.freeze({cancelled:'wire source consumer'});abort.abort(reason);
    const before=memory.calls.length;await assert.rejects(reader.open(current.source,current.selectionId,{signal:abort.signal}),error=>error===reason);
    await assert.rejects(reader.decodeValue(grants.get(397),{signal:abort.signal}),error=>error===reason);assert.equal(memory.calls.length,before);
    let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    let once=true;memory.faults.beforeRead=async request=>{
        if(once&&request.index===journal.index&&request.id.startsWith('h45srcnat1:')){once=false;entered();await held;}
    };
    const stopped=new AbortController(),stoppedReason=Symbol('Only one original-source read stopped');
    const pending=reader.open(current.source,current.selectionId,{signal:stopped.signal});await started;
    const other=new ProtocolNativeActionReader({chainId,profile,provider,store:journal,proofReader});
    const healthy=await other.open(current.source,current.selectionId);
    stopped.abort(stoppedReason);release();await assert.rejects(pending,error=>error===stoppedReason);
    memory.faults.beforeRead=undefined;
    const healthyGrant=await other.authorize(healthy,current.input);
    assert.deepEqual(await other.decodeValue(healthyGrant.grant),targets.get(397).expectedValue);
    await assert.rejects(other.decodeValue(grants.get(397)),{code:'native_invalid_grant'});
    await coordinator.revokeSource('wire-original-prefix');await assert.rejects(reader.decodeValue(grants.get(397)),{code:'authority_unavailable'});
    assert.equal(selected.provider.nativeActions,undefined);assert(legacyProfiles.every(profile=>!Object.hasOwn(profile,'nativeActions')));
    console.log(JSON.stringify({passed:true,originalBlocks:397,originalNative:results,notifications,nativeNotifications,archiveMembers:1488,
        defaultAncestry:256,exactAncestryBoundary:{accepted:141,rejected:140},agedProofsUnavailable:[33,122],genesisZeroToOne:true,
        independentCancellation:true,changedJournalUnavailable:true,nativeActivation:false,fullWorkerQualification:false}));
} finally {
    session?.close?.();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert(basename(directory).startsWith('hapi-native-authority-wire-'));
    rmSync(directory,{recursive:true,force:true});cleanup=true;
}
assert.equal(cleanup,true);
