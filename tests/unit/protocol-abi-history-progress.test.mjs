import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ProtocolAbiCoordinator} from '../../build/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore, protocolAbiCaptureDigest} from '../../build/indexer/protocol/abi-observation-store.js';
import {ProtocolAbiProofReader,protocolAbiCertificateForControl} from '../../build/indexer/protocol/abi-proof.js';
import {historicalAddressIdentity} from '../../build/indexer/protocol/abi-history.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// Service/native-free controls over the actual emitted coordinator, immutable store and CAS transport.
const chainId='1'.repeat(64), block=n=>n.toString(16).padStart(64,'0');
const profile={id:'@eosrio/hyperion-wire-plugin',profileId:'history-progress-fixture',components:[
    {id:'wire-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
const history={interfaceVersion:1,maxCommitsPerDrain:256,maxCommitBytesPerDrain:8*1024*1024,maxMillisecondsPerDrain:250};
async function fixture(count=1,budget=history,unlinked=Infinity) {
    const memory=frontierMemoryClient(), bindings=new ProtocolSourceBindingStore(memory.client,'progress');
    const observations=new ProtocolAbiObservationStore(memory.client,'progress'),store=new ProtocolAbiFrontierStore(memory.client,'progress');
    const schemaJson='{"version":"eosio::abi/1.1"}',contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson})).id;
    const make=ownerId=>new ProtocolAbiCoordinator({chainId,profile,ownerId,bindings,observations,store,historicalCertificates:budget,maxPendingBlocks:512});
    const coordinator=make('progress-owner');await coordinator.start();
    let session='progress-session',{generation}=await coordinator.openSource(contextId,session);
    const selections=[];
    const reopen=async name=>{session=name;({generation}=await coordinator.openSource(contextId,name));};
    const append=async(n,blockId=block(n),previousBlockId=n===1?null:block(n-1))=>{
        const source={chainId,blockNum:n,blockId,previousBlockId};
        const capture={kind:'unattested-ship-result-sections-v1',schemaJson,blockHex:'00',tracesHex:'00',deltasHex:'00'};
        const captureSha256=protocolAbiCaptureDigest(source,capture);
        const selection=(await bindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:session,readerRole:'live',assignmentId:null,
            source,captureSha256,frameSha256:createHash('sha256').update('frame-'+blockId).digest('hex'),head:{blockNum:n,blockId},irreversible:{blockNum:0,blockId:block(0)}})).id;
        const observation=await observations.prepare({schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture,
            observation:{status:'observed',facts:{schemaVersion:1,actionInputs:[],deployments:[],finalStates:[]}}});
        if(n<unlinked)await bindings.prepareObservationLink({schemaVersion:1,selectionId:selection,observationId:observation.id,observationDigest:observation.digest});
        const admitted=await coordinator.admit(selection,generation);
        assert.equal(admitted.status,'accepted');generation=admitted.generation;selections.push(selection);
    };
    for(let n=1;n<=count;n++)await append(n);
    return {memory,bindings,observations,store,coordinator,make,contextId,get generation(){return generation;},selections,append,reopen};
}
function clocked(store,step=100) {
    let now=0;const original=Object.getOwnPropertyDescriptor(performance,'now');
    Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
    const restore=[];const counts=new Map();
    for(const name of ['prepareHistoricalCertificateAddress','prepareAccountState','prepare']) {
        const fn=store[name].bind(store);restore.push(()=>{store[name]=fn;});
        store[name]=async(...args)=>{const result=await fn(...args);now+=step;counts.set(name,(counts.get(name)??0)+1);return result;};
    }
    return {counts,get now(){return now;},tick(ms){now+=ms;},close(){for(const fn of restore)fn();if(original)Object.defineProperty(performance,'now',original);else delete performance.now;}};
}
async function complete(f,maximum=100,walk=false) {
    for(let n=0;n<maximum;n++) {
        await f.coordinator.drain();
        const value=await f.coordinator.inspect();
        assert.ok(f.coordinator.historicalQueue.size<=history.maxCommitsPerDrain);
        if(value.historical&&f.coordinator.historicalQueue.size===0&&(!walk||f.coordinator.historicalWalk?.nextCommitId===null)) {
            const certificate=await f.store.readCertificate(value.historical.activationCertificateId);
            assert.equal(certificate.addressRootId,value.historical.addressRootId);return value;
        }
    }
    assert.fail('historical activation must eventually finish under bounded slow operations');
}

test('bounded slow immutable writes eventually activate across scheduling yields',async()=>{
    const f=await fixture(),clock=clocked(f.store);
    try {
        const control=await complete(f,40);
        assert.equal(control.head.blockNum,1);
        const identity=historicalAddressIdentity(protocolAbiCertificateForControl(control));
        assert.equal((await f.store.readHistoricalAddressRoot(control.historical.addressRootId,identity)).identity.blockNum,1);
    } finally {clock.close();}
});

for(const allowPendingWork of [false,true])test('a block held pending '+(allowPendingWork?'does not stop':'keeps waiting')+' resumed activation',async()=>{
    // Block 2 has no observation link, so it stays pending through every drain.
    const f=await fixture(2,{...history,...(allowPendingWork?{allowPendingWork}:{})},2),clock=clocked(f.store);
    const begin=f.store.beginHistoricalAddressRoot.bind(f.store);let begun=0,resumed=0;
    f.store.beginHistoricalAddressRoot=(...args)=>{begun++;return begin(...args);};
    try {
        let control;
        for(let n=0;n<40&&!control?.historical;n++) {
            await f.coordinator.drain();control=await f.coordinator.inspect();
            assert.equal(control.pending.length,1);
            if(f.coordinator.historicalActivation)resumed++;
        }
        if(!allowPendingWork) {assert.equal(control.historical,undefined);assert.equal(begun,0);return;}
        assert.ok(control.historical);assert.ok(resumed>0,'the activation spanned more than one drain');
        assert.equal(begun,1,'every drain resumed the one retained preparation');
    } finally {clock.close();f.store.beginHistoricalAddressRoot=begin;}
});

test('a held pending block does not cost pending-work mode any extra drains',async()=>{
    const f=await fixture(2,{...history,allowPendingWork:true},2),clock=clocked(f.store,0);
    try {
        await f.coordinator.drain();const control=await f.coordinator.inspect();
        assert.equal(control.pending.length,1);assert.ok(control.historical);
    } finally {clock.close();}
});

for(const waiting of [0,1])test('pending-work walk '+(waiting?'stops after one commit for a queued live admission':'runs its full quantum with no one waiting'),async()=>{
    const f=await fixture(4,{...history,allowPendingWork:true});
    f.coordinator.queuedAdmissions=waiting;
    await f.coordinator.drain();
    f.coordinator.queuedAdmissions=0;
    const {anchor,nextCommitId}=f.coordinator.historicalWalk;
    assert.equal(anchor.blockNum,4);
    if(waiting)assert.notEqual(nextCommitId,null);else assert.equal(nextCommitId,null);
});

const reader=f=>new ProtocolAbiProofReader({chainId,profile,store:f.store.asReadOnly(),maxAncestryBlocks:1,historicalCertificates:true});
async function until(f,predicate,maximum=100) {
    for(let n=0;n<maximum;n++){await f.coordinator.drain();if(predicate())return;}
    assert.fail('required historical phase did not progress');
}

test('slow ancestry and authority reads retain acknowledged phase progress',async()=>{
    const f=await fixture(4),clock=clocked(f.store,0),names=['readControl','readCommit','readCertificate','prepareCertificate'];
    const originals=names.map(name=>[name,f.store[name].bind(f.store)]);
    for(const [name,original] of originals)f.store[name]=async(...args)=>{const result=await original(...args);clock.tick(100);return result;};
    try {
        await complete(f,200,true);
        for(let n=1;n<=4;n++)assert.equal((await reader(f).openHistorical(n)).source.blockNum,n);
    } finally {for(const [name,original] of originals)f.store[name]=original;clock.close();}
});

for(const milliseconds of [125,150,249])test('one authority read below the drain budget permits progress: '+milliseconds+'ms',async()=>{
    const f=await fixture(),clock=clocked(f.store,0),read=f.store.readControl.bind(f.store);
    f.store.readControl=async(...args)=>{const value=await read(...args);clock.tick(milliseconds);return value;};
    try {
        await complete(f,80,true);
        assert.equal((await reader(f).openHistorical(1)).source.blockNum,1);
    } finally {f.store.readControl=read;clock.close();}
});

test('repeated live preemption preserves completed steps with 150ms authority reads',async()=>{
    const f=await fixture(),clock=clocked(f.store,0),read=f.store.readControl.bind(f.store),preempted=new Set(),admissions=[];
    const originals=['readCertificate','prepareHistoricalCertificateAddress','prepareAccountState'].map(name=>[name,f.store[name].bind(f.store)]);
    f.store.readControl=async(...args)=>{const value=await read(...args);clock.tick(150);return value;};
    for(const [name,original] of originals)f.store[name]=async(...args)=>{
        const result=await original(...args);
        if(f.coordinator.historicalActivation&&!preempted.has(name)) {
            preempted.add(name);admissions.push(f.coordinator.admit(f.selections[0],f.generation));
        }
        return result;
    };
    try {
        await complete(f,100,true);
        assert.equal(preempted.size,3);
        for(const admission of admissions)assert.equal((await admission).status,'accepted');
        assert.equal((await reader(f).openHistorical(1)).source.blockNum,1);
    } finally {for(const [name,original] of originals)f.store[name]=original;f.store.readControl=read;clock.close();}
});

const covered=async(f,n)=>{
    try {return (await reader(f).openHistorical(n)).source.blockNum===n;}
    catch(error) {if(error?.code==='historical_source_unavailable')return false;throw error;}
};

test('a fresh head gets its locator while older ancestry is still walking',async()=>{
    const f=await fixture(200,{...history,maxCommitsPerDrain:4,allowPendingWork:true}),clock=clocked(f.store,0);
    try {
        await f.coordinator.drain();
        assert.equal((await f.coordinator.inspect()).head.blockNum,200);
        for(let n=201;n<=210;n++) {
            await f.append(n);await f.coordinator.drain();
            assert.equal((await f.coordinator.inspect()).pending.length,0,'the head never waits for locator work');
            assert.ok(f.coordinator.historicalWalk.nextCommitId,'older ancestry is still being recovered');
            assert.equal(await covered(f,n-1),true,'block '+(n-1)+' has a locator one drain after it landed');
        }
    } finally {clock.close();}
});

test('a one-commit budget still recovers ancestry under a new head every drain',async()=>{
    const f=await fixture(8,{...history,maxCommitsPerDrain:1,allowPendingWork:true}),clock=clocked(f.store,0);
    try {
        await f.coordinator.drain();
        for(let n=9;n<=40;n++){await f.append(n);await f.coordinator.drain();}
        assert.equal((await f.coordinator.inspect()).pending.length,0);
        // Block 1 is queued directly by the first drain; only the walk can reach these.
        for(let n=2;n<=8;n++)assert.equal(await covered(f,n),true,'block '+n+' was recovered');
    } finally {clock.close();}
});

const settle=async(f,height,maximum=2000)=>{
    for(let n=0;n<maximum&&f.coordinator.historicalCompleted?.head.blockNum!==height;n++)await f.coordinator.drain();
    assert.equal(f.coordinator.historicalCompleted?.head.blockNum,height);
};

test('no height is walked twice within a generation',async()=>{
    const f=await fixture(40,{...history,maxCommitsPerDrain:4,allowPendingWork:true}),clock=clocked(f.store,0);
    const prepare=f.store.prepareHistoricalCertificateAddress.bind(f.store),seen=new Map();
    f.store.prepareHistoricalCertificateAddress=async certificate=>{
        seen.set(certificate.head.blockNum,(seen.get(certificate.head.blockNum)??0)+1);return prepare(certificate);};
    try {
        await f.coordinator.drain();
        for(let n=41;n<=50;n++){await f.append(n);await f.coordinator.drain();}
        await settle(f,50);
        // Heads after completion must extend it rather than repeat the covered stretch.
        for(let n=51;n<=55;n++){await f.append(n);await f.coordinator.drain();}
        await settle(f,55);
        for(let n=1;n<=55;n++)assert.equal(seen.get(n),1,'block '+n+' was prepared once');
    } finally {clock.close();f.store.prepareHistoricalCertificateAddress=prepare;}
});

test('a fresh cursor does not outlive a fork',async()=>{
    const f=await fixture(20,{...history,maxCommitsPerDrain:2,allowPendingWork:true}),clock=clocked(f.store,0);
    const other=n=>'f'+block(n).slice(1);
    try {
        await f.coordinator.drain();
        // Five heads per drain outrun this budget, so a fresh segment is mid-flight at the fork.
        for(let n=21;n<=40;n+=5){for(let k=n;k<n+5;k++)await f.append(k);await f.coordinator.drain();}
        assert.ok(f.coordinator.historicalFresh?.nextCommitId,'a fresh segment is in flight');
        // Fork exactly at the cursor's next commit, so everything it would still read is orphaned.
        const fork=(await f.store.readCommit(f.coordinator.historicalFresh.nextCommitId)).source.blockNum;
        await f.append(fork,other(fork),block(fork-1));
        for(let n=fork+1;n<=44;n++)await f.append(n,other(n),other(n-1));
        await settle(f,44);
        for(let n=1;n<=44;n++)assert.equal((await reader(f).openHistorical(n)).source.blockId,n<fork?block(n):other(n));
        assert.equal(f.coordinator.historicalError,undefined);
    } finally {clock.close();}
});

test('a full queue from an older generation does not stop the new one',async()=>{
    const f=await fixture(6,{...history,maxCommitsPerDrain:2,allowPendingWork:true}),clock=clocked(f.store);
    try {
        await until(f,()=>f.coordinator.historicalQueue.size>=2);
        await f.reopen('second-session');await f.append(7);
    } finally {clock.close();}
    await settle(f,7);
    for(let n=1;n<=7;n++)assert.equal(await covered(f,n),true,'block '+n+' has a locator in the new generation');
});

// This drives about 70k store calls, past bun's 5s default on a slow runner. Bun ignores the timeout
// option of node:test, so under bun this one test uses its native form; plain node has no default limit.
const longTest=process.versions.bun?(await import('bun:test')).test:test;
longTest('256-entry queue and multiple buckets finish without losing later admissions',async()=>{
    const f=await fixture(258),clock=clocked(f.store);
    try {
        const control=await complete(f,3000,true),root=await f.store.read('root',control.historical.addressRootId);
        assert.ok(Object.keys(root.buckets).length>100);
        for(let n=1;n<=258;n++)assert.equal((await reader(f).openHistorical(n)).source.blockNum,n);
        assert.equal(f.memory.calls.some(call=>call.method==='search'),false);
    } finally {clock.close();}
},30000);

test('a selected root remains unavailable and its queue retained until activation certification finishes',async()=>{
    const f=await fixture(),clock=clocked(f.store);
    const save=f.store.compareAndSet.bind(f.store);let selected=false;
    f.store.compareAndSet=async(...args)=>{const result=await save(...args);if(args[1].historical){selected=true;clock.tick(250);}return result;};
    try {
        await until(f,()=>selected);
        assert.equal(f.coordinator.historicalQueue.size,1);
        await assert.rejects(reader(f).openHistorical(1));
        await complete(f);
        assert.equal((await reader(f).openHistorical(1)).source.blockNum,1);
    } finally {f.store.compareAndSet=save;clock.close();}
});

test('live admission preempts a completed account prepare without repeating it',async()=>{
    const f=await fixture(),clock=clocked(f.store),prepare=f.store.prepareAccountState.bind(f.store);
    let admission,work,calls=0,afterBoundary;
    f.store.prepareAccountState=async(...args)=>{
        const result=await prepare(...args);calls++;
        if(!admission){work=f.coordinator.historicalActivation;admission=f.coordinator.admit(f.selections[0],f.generation);afterBoundary=f.memory.calls.length;}
        return result;
    };
    try {
        await until(f,()=>!!admission);
        assert.ok(f.memory.calls.slice(afterBoundary).every(call=>call.request.index===f.store.controlIndex),'Only the admitted live task may read after the map boundary');
        assert.equal((await admission).status,'accepted');assert.equal(f.coordinator.historicalActivation,work);
        await complete(f);assert.equal(calls,1);assert.equal((await reader(f).openHistorical(1)).source.blockNum,1);
    } finally {f.store.prepareAccountState=prepare;clock.close();}
});

for(const mode of ['revoke','owner','fork','source','generation','rewind'])test('authority loss discards continuation: '+mode,async()=>{
    const f=await fixture(2),clock=clocked(f.store),prepare=f.store.prepareAccountState.bind(f.store);
    let changed=false,change,oldWork;
    f.store.prepareAccountState=async(...args)=>{
        const result=await prepare(...args);
        if(!changed) {
            changed=true;oldWork=f.coordinator.historicalActivation;
            if(mode==='revoke')change=f.coordinator.revokeSource('progress-session');
            else if(mode==='owner')await f.make('replacement-owner').start();
            else if(mode==='fork') {
                const {selection}=await f.bindings.readSelection(f.selections[1]);
                const replacement=await f.bindings.prepareSelection({...selection,source:{...selection.source,blockId:'f'.repeat(64)}});
                change=f.coordinator.admit(replacement.id,f.generation);
            } else {
                const stored=await f.store.readControl(),next={...stored.value};
                if(mode==='source')next.source={...next.source,contextId:'h45srcctx1:'+'f'.repeat(64)};
                if(mode==='generation')next.generation='replacement-generation';
                if(mode==='rewind')next.head={...oldWork.anchor.head,blockNum:1};
                await f.store.compareAndSet(stored,next);
            }
        }
        return result;
    };
    try {
        await until(f,()=>changed);await change;
        await f.coordinator.drain();
        assert.notEqual(f.coordinator.historicalActivation,oldWork);
        assert.equal((await f.store.readControl()).value.historical,undefined);
        await assert.rejects(reader(f).openHistorical(1));
    } finally {f.store.prepareAccountState=prepare;clock.close();}
});

for(const outcome of ['partial','unknown'])for(const phase of ['locator','account','bucket','root','control','certificate'])
    test('unacknowledged '+phase+' '+outcome+' writes require fresh preparation',async()=>{
        const f=await fixture(),clock=clocked(f.store);let refused=false,repairs=0;
        const matches=request=>phase==='control'?request.id==='control'&&JSON.parse(Buffer.from(request.document.payload,'base64')).historical
            :phase==='locator'?request.id.startsWith('h45abihist1:')
            :phase==='certificate'?request.id.startsWith('h45abicert1:')&&request.document?.kind==='manifest'
                &&!!f.coordinator.historicalActivation?.published
            :request.id.startsWith({account:'h45abist1:',bucket:'h45abibkt1:',root:'h45abiroot1:'}[phase]);
        f.memory.faults.receipt=(result,request)=>{
            if(matches(request)) {
                if(refused){repairs++;return result;}
                refused=true;
                if(outcome==='unknown')throw new Error('controlled unknown write outcome');
                return {...result,_shards:{total:1,successful:0,failed:1}};
            }
            return result;
        };
        try {
            await until(f,()=>refused,100);
            assert.ok(f.coordinator.historicalQueue.size>0);
            // Certificate publication follows the acknowledged canonical-root CAS. A partial
            // certificate may already be primary-visible; it must not retire the queue or its repair.
            if(phase!=='certificate')await assert.rejects(reader(f).openHistorical(1));
            await complete(f);assert.ok(repairs>0,'A fresh write receipt must repair the failed preparation');
            assert.equal((await reader(f).openHistorical(1)).source.blockNum,1);
        } finally {delete f.memory.faults.receipt;clock.close();}
    });

test('store-issued root handles reject forged, cross-store and changed-scope reuse',async()=>{
    const f=await fixture();await complete(f);const current=await f.coordinator.inspect();
    const certificate=protocolAbiCertificateForControl(current),identity=historicalAddressIdentity(certificate);
    const addresses=[await f.store.readHistoricalCertificateAddress(identity)],base=current.historical.addressRootId;
    const handle=f.store.beginHistoricalAddressRoot(base,addresses),other=new ProtocolAbiFrontierStore(f.memory.client,'progress');
    await assert.rejects(f.store.prepareHistoricalAddressRoot(base,addresses,undefined,{}),/another store or scope/);
    await assert.rejects(other.prepareHistoricalAddressRoot(base,addresses,undefined,handle),/another store or scope/);
    await assert.rejects(f.store.prepareHistoricalAddressRoot(null,addresses,undefined,handle),/another store or scope/);
    const cancelled=new Error('controlled cancel');let calls=0;
    await assert.rejects(f.store.prepareHistoricalAddressRoot(base,addresses,async()=>{if(++calls===5)throw cancelled;},handle),error=>error===cancelled);
    assert.equal(await f.store.prepareHistoricalAddressRoot(base,addresses,undefined,handle),base);
    await assert.rejects(f.store.prepareHistoricalAddressRoot(base,addresses,undefined,handle),/another store or scope/);
    assert.equal(await f.store.prepareHistoricalAddressRoot(base,addresses),base,'Existing single prepare keeps identical format and identity');
    assert.equal(await f.store.prepareHistoricalAddressRoot(base,[]),base,'An empty update preserves the existing root');
});

test('replacing the selected base root abandons all old-operation preparation',async()=>{
    const f=await fixture();await complete(f);const selected=await f.coordinator.inspect();
    f.coordinator.queueHistorical(protocolAbiCertificateForControl(selected));
    const clock=clocked(f.store);let previous;
    try {
        await until(f,()=>!!f.coordinator.historicalActivation?.preparation);previous=f.coordinator.historicalActivation;
        const stored=await f.store.readControl(),{historical,...withoutRoot}=stored.value;
        await f.store.compareAndSet(stored,withoutRoot);
        await f.coordinator.drain();
        assert.notEqual(f.coordinator.historicalActivation,previous);
        assert.equal(f.coordinator.historicalActivation.baseRoot,null);
        await assert.rejects(reader(f).openHistorical(1));
        await complete(f);assert.equal((await reader(f).openHistorical(1)).source.blockNum,1);
    } finally {clock.close();}
});

test('a lost retained base root refuses fresh activation and preserves its queued entries',async()=>{
    const f=await fixture();await complete(f);const selected=await f.coordinator.inspect();
    f.coordinator.queueHistorical(protocolAbiCertificateForControl(selected));
    const key=f.memory.key(f.store.recordsIndex,selected.historical.addressRootId),retained=f.memory.documents.get(key);
    f.memory.documents.delete(key);
    try {
        await f.coordinator.drain();
        assert.equal(f.coordinator.historicalActivation,undefined);assert.equal(f.coordinator.historicalQueue.size,1);
        await assert.rejects(reader(f).openHistorical(1));
    } finally {f.memory.documents.set(key,retained);}
    await complete(f);assert.equal((await reader(f).openHistorical(1)).source.blockNum,1);
});

test('deadline expiry after a completed map read starts no further map I/O',async()=>{
    const f=await fixture(),clock=clocked(f.store,0),publish=f.store.prepareHistoricalAddressRoot.bind(f.store),read=f.store.readHistoricalCertificateAddress.bind(f.store);
    let inside=false,injected=false,boundary;
    f.store.prepareHistoricalAddressRoot=async(...args)=>{inside=true;try{return await publish(...args);}finally{inside=false;}};
    f.store.readHistoricalCertificateAddress=async(...args)=>{
        const value=await read(...args);if(inside&&!injected){injected=true;clock.tick(250);boundary=f.memory.calls.length;}return value;
    };
    try {
        await f.coordinator.drain();assert.equal(injected,true);assert.equal(f.memory.calls.length,boundary);
        assert.equal((await f.coordinator.inspect()).historical,undefined);assert.equal(f.coordinator.historicalQueue.size,1);
        await complete(f);
    } finally {f.store.prepareHistoricalAddressRoot=publish;f.store.readHistoricalCertificateAddress=read;clock.close();}
});

test('process replacement starts without the prior volatile preparation or historical authority',async()=>{
    const f=await fixture(),clock=clocked(f.store);
    try {
        await until(f,()=>!!f.coordinator.historicalActivation?.preparation);
        const previous=f.coordinator.historicalActivation,restarted=f.make('process-replacement');await restarted.start();
        assert.equal(restarted.historicalActivation,undefined);assert.equal((await restarted.inspect()).historical,undefined);
        await f.coordinator.drain();assert.notEqual(f.coordinator.historicalActivation,previous);
        await assert.rejects(reader(f).openHistorical(1));
    } finally {clock.close();}
});

for(const [session,code] of [['progress-session','proof_timeout'],['retired-session','source_pending']])
    test('a live source on '+session+' ends with '+code,async()=>{
        // Block 2 stays pending, so only the current session keeps waiting until its bound.
        const f=await fixture(2,history,2);
        await f.coordinator.drain();
        const source={chainId,blockNum:2,blockId:block(2),previousBlockId:block(1)};
        await assert.rejects(reader(f).openLiveSource(source,f.selections[1],{contextId:f.contextId,readerSessionId:session},{timeoutMs:120}),{code});
    });

// A same-session reopen is the reset a fork or replay passes through: pending is emptied
// and open() answers authority_unavailable before it can reach source_pending.
for(const [blockNum,code] of [[2,'authority_unavailable'],[1,'proof_timeout']])
    test('during recovery an unadmitted live source at block '+blockNum+' ends with '+code,async()=>{
        const f=await fixture(2,history,2);
        await f.coordinator.drain();await f.coordinator.openSource(f.contextId,'progress-session');
        const control=await f.coordinator.inspect();
        assert.equal(control.phase,'recovering');assert.deepEqual(control.pending,[]);assert.equal(control.head.blockNum,1);
        const source={chainId,blockNum,blockId:block(blockNum),previousBlockId:blockNum===1?null:block(blockNum-1)};
        await assert.rejects(reader(f).openLiveSource(source,f.selections[blockNum-1],
            {contextId:f.contextId,readerSessionId:'progress-session'},{timeoutMs:120}),{code});
    });

test('an admitted live source keeps waiting while authority is unavailable',async()=>{
    const f=await fixture(2,history,2);await f.coordinator.drain();
    const control=await f.coordinator.inspect();assert.deepEqual(control.pending,[f.selections[1]]);assert.equal(control.head.blockNum,1);
    // Admission and replay only coexist with no head, so the read side alone reports the replay here.
    const store=f.store.asReadOnly(),read=store.readControl.bind(store);let unavailableReads=0;
    store.readControl=async(...args)=>{const stored=await read(...args);unavailableReads++;return {...stored,value:{...stored.value,replayFromBlock:2}};};
    const view=new ProtocolAbiProofReader({chainId,profile,store,maxAncestryBlocks:1,historicalCertificates:true});
    const source={chainId,blockNum:2,blockId:block(2),previousBlockId:block(1)};
    await assert.rejects(view.openLiveSource(source,f.selections[1],{contextId:f.contextId,readerSessionId:'progress-session'},{timeoutMs:120}),{code:'proof_timeout'});
    assert.ok(unavailableReads>1);
});
