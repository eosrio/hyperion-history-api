import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ProtocolAbiCoordinator} from '../../build/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest,protocolAbiObservationJson} from '../../build/indexer/protocol/abi-observation-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// Counts every store request the real coordinator makes per block, wired the way the master wires it.
const chainId='1'.repeat(64),block=n=>n.toString(16).padStart(64,'0'),tx='a'.repeat(64);
const profile={id:'@eosrio/hyperion-wire-plugin',profileId:'round-trip-fixture',components:[
    {id:'wire-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
const schemaJson='{"version":"eosio::abi/1.1"}',bound={metadataReadBoundMs:1000};
const budget={interfaceVersion:1,maxCommitsPerDrain:256,maxCommitBytesPerDrain:8*1024*1024,maxMillisecondsPerDrain:30000};
const empty=()=>({schemaVersion:1,actionInputs:[],deployments:[],finalStates:[]});
const input=(ordinal,globalSequence,account)=>({transactionId:tx,actionOrdinal:ordinal,inputActionOrdinal:ordinal,receiver:account,account,
    name:'act',rawHex:'07000000',globalSequence,receiptAbiSequence:'0'});

function catalogOf(accounts,end=3) {
    const catalogId='h45abihistory1:'+'c'.repeat(64),rowHash='d'.repeat(64);
    const states=accounts.map((account,deltaOrdinal)=>({account,present:true,abiHex:'aabb',protocol:profile,
        source:{catalogId,observationId:'h45abidisk1:'+rowHash,chainId,blockNum:2,blockId:block(2),inputSha256:rowHash,phase:'block-end',deltaOrdinal}}));
    const encoded=new Set(states.map(state=>protocolAbiObservationJson(state)));
    return {baseline:async()=>({catalogId,source:{chainId,blockNum:end,blockId:block(end),previousBlockId:block(end-1)},coverageStart:1,
        lastGlobalSequence:'10',profile,states}),revalidate:async()=>{},blockId:n=>n>=1&&n<=end?block(n):null,
    matchesState:value=>encoded.has(protocolAbiObservationJson(value))};
}

async function fixture(options={}) {
    const memory=frontierMemoryClient(),client=memory.client;
    const bindings=new ProtocolSourceBindingStore(client,'trips',0,{...bound,rememberRecords:true});
    const observations=new ProtocolAbiObservationStore(client,'trips',0,undefined,bound),store=new ProtocolAbiFrontierStore(client,'trips',0,bound);
    // Only this one method: anything else asking the remembering handle for records would throw here.
    const reader=store.asAccountReader(),accountReader={readAccount:(...args)=>reader.readAccount(...args)};
    // Source records are prepared by workers, which keep the default fresh read on every call.
    const workerBindings=new ProtocolSourceBindingStore(client,'trips',0),workerObservations=new ProtocolAbiObservationStore(client,'trips',0);
    const contextId=(await workerBindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson})).id;
    const coordinator=new ProtocolAbiCoordinator({chainId,profile,ownerId:'owner',bindings,observations,store,accountReader,maxPendingBlocks:512,...options});
    await coordinator.start();
    let {generation}=await coordinator.openSource(contextId,'session');
    async function prepare(n,facts) {
        const source={chainId,blockNum:n,blockId:block(n),previousBlockId:n===1?null:block(n-1)};
        const capture={kind:'unattested-ship-result-sections-v1',schemaJson,blockHex:'00',tracesHex:'00',deltasHex:'00'};
        const captureSha256=protocolAbiCaptureDigest(source,capture);
        const selectionId=(await workerBindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:'session',readerRole:'live',assignmentId:null,
            source,captureSha256,frameSha256:createHash('sha256').update('frame-'+n).digest('hex'),head:{blockNum:n,blockId:block(n)},irreversible:{blockNum:0,blockId:block(0)}})).id;
        const observed=await workerObservations.prepare({schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture,observation:{status:'observed',facts}});
        await workerBindings.prepareObservationLink({schemaVersion:1,selectionId,observationId:observed.id,observationDigest:observed.digest});
        return selectionId;
    }
    async function admit(selectionId) {
        const result=await coordinator.admit(selectionId,generation);generation=result.generation;
        assert.equal(result.status,'accepted');
    }
    return {memory,coordinator,store,prepare,admit,get generation(){return generation;}};
}

const methods=['create','index','get','mget','getIndex'];
function tally(calls) {
    const counts=Object.fromEntries(methods.map(name=>[name,0]));
    for(const {method} of calls)if(Object.hasOwn(counts,method))counts[method]++;
    return counts;
}
const perBlock=(calls,blocks)=>Object.fromEntries(Object.entries(tally(calls)).map(([name,value])=>[name,Number((value/blocks).toFixed(2))]));
const report=(name,value)=>console.log('ROUND_TRIPS '+JSON.stringify({name,...value}));
// Metadata requests depend on the clock, so only the store operations are exact.
const operations=({getIndex:_metadata,...counts})=>counts;

/** One block at a time, the way a live head arrives. */
async function following(f,first,count,facts=()=>empty()) {
    const prepare=[],admit=[],drain=[],calls=f.memory.calls;
    for(let n=first;n<first+count;n++) {
        let mark=calls.length;const selectionId=await f.prepare(n,facts(n));prepare.push(...calls.slice(mark));
        mark=calls.length;await f.admit(selectionId);admit.push(...calls.slice(mark));
        mark=calls.length;assert.equal((await f.coordinator.drain()).committed,1);drain.push(...calls.slice(mark));
    }
    return {prepare:perBlock(prepare,count),admit:perBlock(admit,count),drain:perBlock(drain,count)};
}
const warmed=async(f,first,warm,count,facts)=>{await following(f,first,warm,facts);return following(f,first+warm,count,facts);};

test('live blocks without historical work',async()=>{
    const counts=await warmed(await fixture(),1,4,32);
    report('live',counts);
    assert.deepEqual(operations(counts.admit),{create:0,index:1,get:3,mget:0});
    assert.deepEqual(operations(counts.drain),{create:4,index:1,get:5,mget:2});
});
test('live blocks with historical certificates',async()=>{
    const counts=await warmed(await fixture({historicalCertificates:budget}),1,4,32);
    report('live-historical',counts);
    const {get,...writes}=operations(counts.drain);
    assert.deepEqual(writes,{create:14,index:2,mget:3});
    assert.ok(get<=31,'Historical reads per block: '+get);
});
test('a backlog with historical certificates',async()=>{
    const f=await fixture({historicalCertificates:{...budget,allowPendingWork:true}}),count=32,calls=f.memory.calls;
    await following(f,1,4);
    const admit=[],selections=[],prepare=[];
    for(let n=5;n<5+count;n++) {
        let mark=calls.length;selections.push(await f.prepare(n,empty()));prepare.push(...calls.slice(mark));
        mark=calls.length;await f.admit(selections.at(-1));admit.push(...calls.slice(mark));
    }
    const mark=calls.length;
    for(let n=0;n<8;n++)await f.coordinator.drain();
    report('backlog-historical',{prepare:perBlock(prepare,count),admit:perBlock(admit,count),drain:perBlock(calls.slice(mark),count)});
});
// A later check would also notice these, so each case proves the very next store request never starts.
test('authority lost during a map step stops the next map step',async()=>{
    const f=await fixture({historicalCertificates:budget}),prepare=f.store.prepareAccountState.bind(f.store);
    let mark;
    f.store.prepareAccountState=async(...args)=>{
        const result=await prepare(...args);
        if(mark===undefined) {
            const control=await f.store.readControl();
            await f.store.compareAndSet(control,{...control.value,ownerId:'other-owner',revision:control.value.revision+1});
            mark=f.memory.calls.length;
        }
        return result;
    };
    await f.admit(await f.prepare(1,empty()));await f.coordinator.drain();
    assert.notEqual(mark,undefined,'The map step must run');
    assert.ok(f.memory.calls.slice(mark).every(call=>call.request.index===f.store.controlIndex),'Only the authority read may follow');
});
for(const [arrival,named] of [['admission','an admission'],['revocation','a revocation']])test('a reused walk check still honours '+named+' that arrives after it',async()=>{
    const f=await fixture({historicalCertificates:budget}),selection=await f.prepare(1,empty());await f.admit(selection);
    const read=f.store.readCommit.bind(f.store),certify=f.store.prepareCertificate.bind(f.store);
    const check=f.coordinator.assertHistoricalAuthority.bind(f.coordinator);
    let armed=false,arrived,later=0;
    f.store.readCommit=async(...args)=>{const value=await read(...args);if(args[2]===undefined&&arrived===undefined)armed=true;return value;};
    f.store.prepareCertificate=async(...args)=>{if(arrived)later++;return certify(...args);};
    f.coordinator.assertHistoricalAuthority=async(...args)=>{
        const value=await check(...args);
        if(armed){armed=false;arrived=arrival==='admission'?f.coordinator.admit(selection,f.generation):f.coordinator.revokeSource('session');}
        return value;
    };
    await f.coordinator.drain();
    assert.notEqual(arrived,undefined,'The walk must reach its check');
    assert.equal(later,0,'The next step must not start');
    await arrived;
});
const contracts=Array.from({length:8},(_,index)=>'contract'+index);
const active=n=>({...empty(),actionInputs:contracts.map((account,index)=>input(index+1,String(100+n*contracts.length+index),account))});
test('blocks with eight active contracts',async()=>{
    const counts=await warmed(await fixture({diskAbiHistory:catalogOf(contracts)}),4,4,32,active);
    report('active-contracts',counts);
    assert.deepEqual(operations(counts.drain),{create:4,index:17,get:7,mget:10});
});
test('overlapping bound state writes all settle before a failure stops the block',async()=>{
    const f=await fixture({diskAbiHistory:catalogOf(contracts)}),state=request=>request.id.startsWith('h45abist1:');
    await following(f,4,2,active);
    const head=(await f.coordinator.inspect()).head;
    await f.admit(await f.prepare(6,active(6)));
    let running=0,peak=0,failed=false;
    f.memory.faults.beforeWrite=async request=>{
        if(!state(request))return;
        running++;peak=Math.max(peak,running);await new Promise(resolve=>setImmediate(resolve));running--;
    };
    f.memory.faults.receipt=(result,request)=>{
        if(failed||!state(request))return result;
        failed=true;return {...result,_shards:{total:1,successful:0,failed:1}};
    };
    await assert.rejects(f.coordinator.drain(),/durable write receipt/);
    assert.equal(running,0,'No write may outlive the failed block');
    assert.ok(peak>1,'Independent states overlap');
    delete f.memory.faults.beforeWrite;delete f.memory.faults.receipt;
    assert.deepEqual((await f.coordinator.inspect()).head,head,'A failed bound state commits nothing');
    assert.equal((await f.coordinator.drain()).committed,1);
});
