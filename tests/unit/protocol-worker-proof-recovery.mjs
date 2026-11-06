import assert from 'node:assert/strict';
import {test} from 'node:test';
import {registerHooks} from 'node:module';
import {performance} from 'node:perf_hooks';
const hooks=registerHooks({resolve(specifier,context,next){
    if(context.parentURL?.endsWith('/protocol-native-authorization-host-fixture.ts')&&specifier.startsWith('../../src/'))
        return next(new URL(specifier.replace('../../src/','../../build/'),context.parentURL).href,context);
    return next(specifier,context);
}});
const {ProtocolNativeActionReader}=await import('../../build/indexer/protocol/native-authorization.js');
const {ProofConsumerScope}=await import('../../build/indexer/protocol/proof-consumer-scope.js');
const {nativeAuthorizationFixture,chainId,profile,gate,holdRead}=await import('./protocol-native-authorization-host-fixture.ts');
hooks.deregister();
async function fixture(){
    const f=await nativeAuthorizationFixture({nativeActionInterfaceVersion:1,historicalCertificates:true,maxAncestryBlocks:1});
    await f.append(3);await f.append(4);for(let i=0;i<4;i++)await f.coordinator.drain();
    const pair=ProtocolNativeActionReader.forWorker({chainId,profile,provider:f.provider,proofReader:f.proofs(),store:f.nativeStore});
    return {...f,pair};
}
async function opened(f){
    const pair=await f.pair.waitForOpen(f.selected.source,f.selected.selectionId);
    const decision=await f.pair.native.authorize(pair.nativeView,f.selected.inputs[0]);
    if(decision.kind!=='native')throw new Error('Expected native origin');
    return {...pair,grant:decision.grant};
}
function holdActivation(f){
    const entered=gate(),release=gate(),prepare=f.frontier.prepareCertificate.bind(f.frontier);
    f.frontier.prepareCertificate=async(value)=>{if(value.kind==='settled-historical-abi-address-root'){
        entered.release();await release.promise;}return prepare(value);};
    return {entered:entered.promise,release:release.release,restore(){f.frontier.prepareCertificate=prepare;}};
}
test('worker resumes a real historical activation manifest gap without recreating native authority or values',async()=>{
    const f=await fixture(),scope=new ProofConsumerScope('worker-real-gap');
    await scope.run(async()=>{
        const issued=await opened(f),value=await f.pair.native.decodeValue(issued.grant),before={...f.calls};
        const hold=holdActivation(f),moving=f.append(5);await hold.entered;
        let misses=0;const get=f.client.get;f.client.get=async(...args)=>{try{return await get(...args);}catch(e){
            if(args[0].id?.startsWith('h45abicert1:')&&e.meta?.statusCode===404)misses++;throw e;}};
        const checking=f.pair.native.revalidate(issued.nativeView);
        try {await new Promise(r=>setTimeout(r,60));assert(misses>0);hold.release();await moving;await checking;
            assert.partialDeepStrictEqual(await f.pair.native.metadata(issued.grant),{source:{chainId,blockNum:2,blockId:f.selected.source.blockId}});
            assert.deepEqual(value,{rawHex:'0102'});assert.equal(f.calls.observe,before.observe);assert.equal(f.calls.decode,before.decode);
        }finally{hold.release();hold.restore();f.client.get=get;}
    });await scope.closeAndDrain();
});
test('worker retries valid root/head movement with fresh exact membership; API issuer remains fail-closed',async()=>{
    for(const worker of [false,true]){
        const f=await fixture(),scope=new ProofConsumerScope('root-movement-'+worker);
        await scope.run(async()=>{
            const reader=worker?f.pair.native:f.reader(),view=worker?(await opened(f)).nativeView:await reader.open(f.selected.source,f.selected.selectionId);
            let controls=0;const hold=holdRead(f.client,r=>r.index===f.frontier.controlIndex&&r.id==='control'&&++controls===2);
            const checking=reader.revalidate(view);const observed=checking.then(()=>null,e=>e);
            try{await hold.entered;await f.append(5);hold.release();const error=await observed;
                if(worker){assert.equal(error,null);}else assert.equal(error.code,'authority_changed');
            }finally{hold.release();hold.restore();}
        });await scope.closeAndDrain();
    }
});
test('worker does not retry corrupt chunks, missing root, invalid control or replacement owner',async()=>{
    for(const mode of ['chunk','root','invalid','owner']){
        const f=await fixture(),scope=new ProofConsumerScope('worker-closed-'+mode);
        await scope.run(async()=>{
            const issued=await opened(f);let count=0;const get=f.client.get;
            if(mode==='owner')await f.replaceOwner();
            else if(mode==='chunk'){
                const c=await f.coordinator.inspect(),id=c.historical.activationCertificateId;
                const manifest=f.memory.documents.get(f.memory.key(f.frontier.recordsIndex,id));
                f.memory.documents.delete(f.memory.key(f.frontier.recordsIndex,manifest.document.chunk_ids[0]));
            }else{
                const c=await f.frontier.readControl(),value=structuredClone(c.value);
                if(mode==='root')value.historical=null;else value.schemaVersion=999;
                await f.frontier.compareAndSet(c,value);
            }
            f.client.get=async(...args)=>{count++;return get(...args);};
            try{await assert.rejects(f.pair.native.revalidate(issued.nativeView),{code:mode==='chunk'?'certificate_unavailable':mode==='invalid'?'invalid_proof':mode==='root'?'historical_source_unavailable':'authority_unavailable'});
                assert(count<15);
            }finally{f.client.get=get;}
        });await scope.closeAndDrain();
    }
});
test('cancellation during worker certificate recovery stops the original scope without replay',async()=>{
    const f=await fixture(),scope=new ProofConsumerScope('worker-gap-cancel'),hold=holdActivation(f);let moving;
    try{await assert.rejects(scope.run(async()=>{
        const issued=await opened(f);moving=f.append(5);await hold.entered;
        const checking=f.pair.native.revalidate(issued.nativeView);setTimeout(()=>scope.fence(),35);await checking;
    }),{code:'worker_attempt_fenced'});}finally{hold.release();if(moving)await moving;hold.restore();await scope.closeAndDrain();}
});

test('paired readers share one recovery budget while healthy checks remain allowed after expiry',async()=>{
    const f=await fixture(),scope=new ProofConsumerScope('worker-shared-recovery');
    const realNow=performance.now.bind(performance);let now=realNow();
    await scope.run(async()=>{
        const first=await opened(f),secondPair=ProtocolNativeActionReader.forWorker({chainId,profile,provider:f.provider,proofReader:f.proofs(),store:f.nativeStore});
        const second=await secondPair.waitForOpen(f.selected.source,f.selected.selectionId);
        const c=await f.coordinator.inspect(),id=c.historical.activationCertificateId,key=f.memory.key(f.frontier.recordsIndex,id);
        const saved=f.memory.documents.get(key);
        performance.now=()=>now;f.memory.documents.delete(key);
        const recovering=f.pair.native.revalidate(first.nativeView);const outcome=recovering.then(()=>null,e=>e);
        try{
            await new Promise(r=>setTimeout(r,35));f.memory.documents.set(key,saved);assert.equal(await outcome,null);
            now+=5001;
            // An elapsed recovery clock never imposes a new wall timeout on healthy processing.
            await f.pair.native.revalidate(first.nativeView);await secondPair.native.revalidate(second.nativeView);
            f.memory.documents.delete(key);const began=performance.now();
            await assert.rejects(secondPair.native.revalidate(second.nativeView),{code:'proof_timeout'});
            assert(performance.now()-began<150);
        }finally{performance.now=realNow;f.memory.documents.set(key,saved);}
    });await scope.closeAndDrain();
});
test('worker recovery cannot rescue a changed original owner or mutated native output',async()=>{
    for(const mode of ['owner','value']){
        const f=await fixture(),scope=new ProofConsumerScope('worker-change-'+mode);
        await scope.run(async()=>{
            const issued=await opened(f),hold=holdActivation(f),moving=f.append(5);await hold.entered;
            const checking=f.pair.native.revalidate(issued.nativeView),outcome=checking.then(()=>null,e=>e);
            try{
                await new Promise(r=>setTimeout(r,35));
                if(mode==='owner')await f.replaceOwner();
                hold.release();await moving;const error=await outcome;
                if(mode==='owner')assert.equal(error.code,'authority_unavailable');
                else {assert.equal(error,null);await assert.rejects(f.pair.native.verifyValue(issued.grant,{rawHex:'ff'}),{code:'native_value_mismatch'});}
            }finally{hold.release();hold.restore();}
        });await scope.closeAndDrain();
    }
});

for(const cancellation of [false,true])test(`recovery ${cancellation?'cancellation':'deadline'} stops an abort-ignoring read while ownership stays pending`,async()=>{
    const f=await fixture(),scope=new ProofConsumerScope('worker-uncooperative-recovery'),held=gate(),release=gate();
    let restore=()=>{},lateReads=0;
    const started=performance.now();
    const result=scope.run(async()=>{
        const issued=await opened(f),c=await f.coordinator.inspect(),key=f.memory.key(f.frontier.recordsIndex,c.historical.activationCertificateId);
        const saved=f.memory.documents.get(key),get=f.client.get;let missing=false,blocked=false;
        f.memory.documents.delete(key);
        f.client.get=async(...args)=>{
            if(missing&&!blocked&&args[0].id==='control'){
                blocked=true;held.release();await release.promise;
            }else if(blocked)lateReads++;
            try{return await get(...args);}catch(e){if(args[0].id?.startsWith('h45abicert1:')&&e.meta?.statusCode===404)missing=true;throw e;}
        };
        restore=()=>{f.client.get=get;f.memory.documents.set(key,saved);};
        await f.pair.native.revalidate(issued.nativeView);
    });
    const outcome=result.then(()=>null,e=>e);await held.promise;
    if(cancellation)scope.fence();
    const error=await outcome;assert.equal(error.code,cancellation?'worker_attempt_fenced':'proof_timeout');assert(performance.now()-started<(cancellation?1000:6500));
    const before=lateReads;let drained=false;const ending=scope.closeAndDrain().then(()=>{drained=true;});
    await new Promise(r=>setTimeout(r,30));assert.equal(drained,false);assert(scope.snapshot().pendingOperations>0);
    release.release();await ending;restore();assert.equal(lateReads,before);assert.equal(scope.snapshot().state,'drained');
});
