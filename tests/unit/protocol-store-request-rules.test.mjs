import test from 'node:test';
import assert from 'node:assert/strict';
import {ImmutableProtocolBundleStore} from '../../build/indexer/protocol/immutable-bundle-store.js';
import {ProtocolAbiFrontierStore,ProtocolAbiFrontierRecordMemo} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ProtocolSourceBindingStore,protocolSourceObservationLinkId} from '../../build/indexer/protocol/source-bindings.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// Fewer requests must never mean fewer receipts: each case pins a rule the cheaper request order has to keep.
const chainId='1'.repeat(64),hex=value=>value.repeat(64);
const profile={id:'@eosrio/hyperion-wire-plugin',profileId:'request-rules',components:[
    {id:'wire-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
function bundles(bounds) {
    const memory=frontierMemoryClient(),store=new ImmutableProtocolBundleStore(memory.client,'rules',0,'rules','rules-v1',bounds);
    const stored=id=>memory.documents.get(memory.key(store.index,id));
    return {memory,store,stored,drop:id=>memory.documents.delete(memory.key(store.index,id))};
}
const requests=(memory,mark)=>memory.calls.slice(mark).map(call=>call.method);
const writes=(memory,mark)=>memory.calls.slice(mark).filter(call=>['create','index'].includes(call.method))
    .map(call=>[call.method,call.request.id]);
const partial=result=>({...result,_shards:{total:1,successful:0,failed:1}});

test('a stored record takes one read and a fresh write per document, chunk first',async()=>{
    const {memory,store}=bundles(),{digest}=await store.prepare('record',{value:1}),chunk=`record:${digest}:0`,mark=memory.calls.length;
    assert.equal((await store.prepare('record',{value:1},undefined,'present')).digest,digest);
    assert.deepEqual(requests(memory,mark),['getIndex','mget','index','index']);
    assert.deepEqual(writes(memory,mark),[['index',chunk],['index','record']]);
    for(const {request} of memory.calls.slice(mark).filter(call=>call.method==='index')) {
        assert.ok(Number.isSafeInteger(request.if_seq_no));assert.equal(request.wait_for_active_shards,'all');
    }
});

for(const target of ['chunk','manifest'])test(`a partial ${target} receipt refuses a stored record`,async()=>{
    const {memory,store}=bundles(),{digest}=await store.prepare('record',{value:1});
    const id=target==='chunk'?`record:${digest}:0`:'record',mark=memory.calls.length;
    memory.faults.receipt=(result,request)=>request.id===id?partial(result):result;
    await assert.rejects(store.prepare('record',{value:1},undefined,'present'),/durable write receipt/);
    delete memory.faults.receipt;
    if(target==='chunk')assert.deepEqual(writes(memory,mark),[['index',id]],'No manifest write may follow a partial chunk');
});

test('a stored record that lost a write race still ends with its own complete receipt',async()=>{
    const {memory,store,stored}=bundles(),{digest}=await store.prepare('record',{value:1}),chunk=`record:${digest}:0`,mark=memory.calls.length;
    let raced=false;
    memory.faults.beforeWrite=(request,method)=>{if(method==='index'&&request.id===chunk&&!raced){raced=true;stored(chunk).seq+=100;}};
    await store.prepare('record',{value:1},undefined,'present');
    assert.deepEqual(writes(memory,mark),[['index',chunk],['create',chunk],['index',chunk],['index','record']]);
});

test('a stored record never overwrites different bytes',async()=>{
    const {memory,store,stored}=bundles(),{digest}=await store.prepare('record',{value:1}),chunk=`record:${digest}:0`;
    stored(chunk).document={...stored(chunk).document,digest:hex('0')};
    let mark=memory.calls.length;
    await assert.rejects(store.prepare('record',{value:1},undefined,'present'),/conflict/);
    assert.deepEqual(writes(memory,mark),[]);
    mark=memory.calls.length;
    await assert.rejects(store.prepare('record',{value:2},undefined,'present'),/conflict/);
    assert.deepEqual(writes(memory,mark),[],'A different manifest refuses before any chunk write');
});

test('an expected record that is absent or half written takes the ordinary repair',async()=>{
    const {memory,store,drop}=bundles(),{digest}=await store.prepare('record',{value:1}),chunk=`record:${digest}:0`;
    drop('record');let mark=memory.calls.length;
    await store.prepare('record',{value:1},undefined,'present');
    assert.deepEqual(writes(memory,mark),[['create',chunk],['index',chunk],['create','record']],'A found chunk still needs a fresh receipt');
    drop(chunk);mark=memory.calls.length;
    await store.prepare('record',{value:1},undefined,'present');
    assert.deepEqual(writes(memory,mark),[['create',chunk],['create','record'],['index','record']],'A lost chunk is written again before the manifest');
    mark=memory.calls.length;
    await store.prepare('new',{value:2},undefined,'present');
    assert.equal(writes(memory,mark).at(-1)[1],'new');
    assert.deepEqual(writes(memory,mark).map(([method])=>method),['create','create']);
});

test('a multi-chunk record keeps the ordered path when expected',async()=>{
    const {memory,store}=bundles({chunkBytes:8,maximumBytes:1024,maximumChunks:128});
    const record={value:'x'.repeat(40)};await store.prepare('record',record);const mark=memory.calls.length;
    await store.prepare('record',record,undefined,'present');
    assert.equal(requests(memory,mark)[1],'get');
    const written=writes(memory,mark);
    assert.ok(written.length>4);
    assert.deepEqual(written.slice(-2),[['create','record'],['index','record']],'The manifest stays last');
    assert.equal(written.filter(([,id])=>id==='record').length,2);
});

test('only a caller that names an absent record skips the opening manifest check',async()=>{
    const {memory,store,stored}=bundles();await store.prepare('seed',{value:0});
    let mark=memory.calls.length;await store.prepare('hashed',{value:1},undefined,'absent');
    assert.deepEqual(requests(memory,mark),['getIndex','create','create']);
    await store.prepare('plain',{value:1});
    mark=memory.calls.length;
    await assert.rejects(store.prepare('plain',{value:2}),/conflict/);
    assert.deepEqual(writes(memory,mark),[],'The default still refuses before any chunk write');
    const before=structuredClone(stored('hashed').document);
    await assert.rejects(store.prepare('hashed',{value:2},undefined,'absent'),/conflict/);
    assert.deepEqual(stored('hashed').document,before,'The manifest write still compares what it finds');
});

test('an existing record prepared as absent still gets a fresh receipt per document',async()=>{
    const {memory,store}=bundles(),{digest}=await store.prepare('record',{value:1}),mark=memory.calls.length;
    await store.prepare('record',{value:1},undefined,'absent');
    assert.deepEqual(writes(memory,mark),[['create',`record:${digest}:0`],['index',`record:${digest}:0`],['create','record'],['index','record']]);
});

test('every frontier ID hashes its record, so its prepares skip the opening read',async()=>{
    const memory=frontierMemoryClient(),store=new ProtocolAbiFrontierStore(memory.client,'rules');
    await store.prepareCommit({height:1});
    const mark=memory.calls.length;await store.prepareCommit({height:2});await store.prepareCertificate({height:2});
    assert.equal(requests(memory,mark).filter(method=>method==='get').length,0);
});

test('a readback finds a one-chunk record in one read and keeps every read check',async()=>{
    const memory=frontierMemoryClient(),store=new ProtocolAbiFrontierStore(memory.client,'rules');
    const {id,digest}=await store.prepareCommit({height:1});
    const key=name=>memory.key(store.recordsIndex,name),chunk=`${id}:${digest}:0`;
    const mark=memory.calls.length;
    assert.deepEqual(await store.readCommit(id,undefined,digest),{height:1});
    assert.deepEqual(requests(memory,mark).filter(method=>method!=='getIndex'),['mget']);
    const payload=memory.documents.get(key(chunk)).document.payload;
    memory.documents.get(key(chunk)).document.payload=Buffer.from('{"height":2}').toString('base64');
    await assert.rejects(store.readCommit(id,undefined,digest),error=>error.code==='invalid');
    memory.documents.get(key(chunk)).document.payload=payload;
    const saved=memory.documents.get(key(chunk));memory.documents.delete(key(chunk));
    await assert.rejects(store.readCommit(id,undefined,digest),error=>error.code==='incomplete');
    memory.documents.set(key(chunk),saved);memory.documents.delete(key(id));
    await assert.rejects(store.readCommit(id,undefined,digest),error=>error.code==='missing');
});

test('a readback with the wrong digest or several chunks falls back to the ordered read',async()=>{
    const {store}=bundles(),{digest}=await store.prepare('record',{value:1});
    assert.notEqual(digest,hex('0'));
    assert.deepEqual(await store.read('record',undefined,hex('0')),{value:1});
    const small=bundles({chunkBytes:8,maximumBytes:1024,maximumChunks:128}),record={value:'x'.repeat(40)};
    const prepared=await small.store.prepare('record',record);
    assert.deepEqual(await small.store.read('record',undefined,prepared.digest),record);
});

test('a readback never answers from the record memo',async()=>{
    const memory=frontierMemoryClient(),store=new ProtocolAbiFrontierStore(memory.client,'rules',0,{recordMemo:new ProtocolAbiFrontierRecordMemo()});
    const {id,digest}=await store.prepareCommit({height:1});
    await store.readCommit(id);memory.documents.delete(memory.key(store.recordsIndex,id));
    assert.deepEqual(await store.readCommit(id),{height:1});
    await assert.rejects(store.readCommit(id,undefined,digest),error=>error.code==='missing');
});

test('a root preparation checks before its first store request',async()=>{
    const memory=frontierMemoryClient(),store=new ProtocolAbiFrontierStore(memory.client,'rules');
    const root=await store.prepareState(null,[{account:'alpha',state:{account:'alpha',abiHex:'aa'}}]),cancelled=new Error('cancelled'),mark=memory.calls.length;
    await assert.rejects(store.prepareHistoricalAddressRoot(root,[],async()=>{throw cancelled;}),error=>error===cancelled);
    assert.deepEqual(requests(memory,mark),[]);
});

async function bindingFixture() {
    const memory=frontierMemoryClient(),writer=new ProtocolSourceBindingStore(memory.client,'rules');
    const contextId=(await writer.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson:'{"version":"eosio::abi/1.1"}'})).id;
    const selectionId=(await writer.prepareSelection({schemaVersion:1,contextId,readerSessionId:'session',readerRole:'live',assignmentId:null,
        source:{chainId,blockNum:1,blockId:hex('2'),previousBlockId:null},captureSha256:hex('3'),frameSha256:hex('4'),
        head:{blockNum:1,blockId:hex('2')},irreversible:{blockNum:0,blockId:hex('0')}})).id;
    await writer.prepareObservationLink({schemaVersion:1,selectionId,observationId:'h45abi1:'+hex('5'),observationDigest:hex('6')});
    return {memory,writer,contextId,selectionId,remembering:new ProtocolSourceBindingStore(memory.client,'rules',0,{rememberRecords:true})};
}

test('source records are remembered only on request',async()=>{
    const f=await bindingFixture(),first=await f.remembering.readSelection(f.selectionId),mark=f.memory.calls.length;
    assert.deepEqual(await f.remembering.readSelection(f.selectionId),first);
    assert.equal(await f.remembering.readContext(f.contextId),first.context);
    assert.deepEqual(requests(f.memory,mark),[]);
    await f.writer.readSelection(f.selectionId);
    assert.ok(requests(f.memory,mark).filter(method=>method==='get').length>=4,'A default store reads every time');
    f.memory.documents.delete(f.memory.key(f.writer.index,f.selectionId));
    assert.deepEqual(await f.remembering.readSelection(f.selectionId),first);
    await assert.rejects(f.writer.readSelection(f.selectionId),error=>error.code==='missing');
});

test('an observation link is never remembered, because its ID does not hash its content',async()=>{
    const f=await bindingFixture(),link=protocolSourceObservationLinkId(f.selectionId);
    await f.remembering.readObservationLink(f.selectionId);
    f.memory.documents.delete(f.memory.key(f.writer.index,link));
    await assert.rejects(f.remembering.readObservationLink(f.selectionId),error=>error.code==='missing');
});

test('a failed source read is never remembered',async()=>{
    const f=await bindingFixture(),key=f.memory.key(f.writer.index,f.selectionId),saved=f.memory.documents.get(key);
    f.memory.documents.delete(key);
    await assert.rejects(f.remembering.readSelection(f.selectionId),error=>error.code==='missing');
    f.memory.documents.set(key,saved);
    assert.equal((await f.remembering.readSelection(f.selectionId)).selection.source.blockNum,1);
});

test('a record that fails its identity check is never remembered',async()=>{
    const f=await bindingFixture(),forged='h45srcsel1:'+hex('9');
    const raw=new ImmutableProtocolBundleStore(f.memory.client,'rules',0,'protocol-source-bindings','protocol-source-bindings-v1');
    await raw.prepare(forged,(await f.writer.readSelection(f.selectionId)).selection);
    for(let attempt=0;attempt<2;attempt++)await assert.rejects(f.remembering.readSelection(forged),error=>error.code==='invalid');
});

test('the account reader remembers records and cannot write, and the writing store stays fresh',async()=>{
    const memory=frontierMemoryClient(),store=new ProtocolAbiFrontierStore(memory.client,'rules');
    const root=await store.prepareState(null,[{account:'alpha',state:{account:'alpha',abiHex:'aa'}}]),reader=store.asAccountReader();
    const state=await reader.readAccount(root,'alpha'),mark=memory.calls.length;
    assert.equal(await reader.readAccount(root,'alpha'),state);
    assert.deepEqual(requests(memory,mark),[]);
    await assert.rejects(reader.prepareCommit({height:1}),/Read-only/);
    await assert.rejects(reader.prepareAccountState({account:'alpha'}),/Read-only/);
    memory.documents.clear();
    assert.equal(await reader.readAccount(root,'alpha'),state);
    await assert.rejects(store.readAccount(root,'alpha'),error=>error.code==='missing');
});
