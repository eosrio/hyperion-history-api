import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createMongoDbStatefulAdapter} from '../dist/stateful.js';
import {sdk,configured,setup,source,run,view,read,physical,limits,definition,hex,guard,databaseFixture,metadataEnvelopeBoundary} from './stateful-fixture.mjs';
const code=n=>e=>e.code===n;
const A=async p=>{p.put('asset','one',{id:'9007199254740993',vector:['0','18446744073709551615'],owner:'alice',mutable:{old:true},nil:null});
    p.put('asset','one',{...(await p.get('asset','one')).value,mutable:{replacement:true},owner:'bob'});p.put('collection','one',{name:'initial'});};

test('explicit opt-in validates native profile/declaration before I/O; old factories gain no support',async()=>{
    const s=await configured();assert.equal(s.fixture.native.length,0);
    assert.equal(Object.hasOwn(await import('../dist/index.js'),'createMongoDbStatefulAdapter'),false);
    await assert.rejects(createMongoDbStatefulAdapter({...s.options,operationTimeoutMS:undefined}));
    await assert.rejects(createMongoDbStatefulAdapter({...s.options,rollbackRetentionBlocks:4097}));
    const wide={...limits(),value:{...limits().value,recordBytes:16*1024*1024}};
    await assert.rejects(createMongoDbStatefulAdapter({...s.options,declaration:await sdk.captureStatefulDeclaration(definition(),wide)}),code('stateful.capability-unavailable'));
    assert.equal(s.fixture.native.length,0);s.fixture.hello={isWritablePrimary:true,maxWireVersion:25,logicalSessionTimeoutMinutes:30};
    await assert.rejects(s.adapter.initialize(s.declaration),code('stateful.capability-unavailable'));
    assert.equal(s.fixture.storage.size,0);
});

test('distinct SDK module handles recapture only for validation; host negotiation/fences remain mandatory',async()=>{
    const url=pathToFileURL(resolve('node_modules/@eosrio/hyperion-sdk/dist/projection-stateful.js')).href+'?independent-host-instance';
    const hostSdk=await import(url),s=await configured();
    const foreign=await hostSdk.negotiateStatefulProjection(s.declaration.definition,s.declaration.limits,
        {family:hostSdk.STATEFUL_FAMILY,interfaceVersion:1,supported:hostSdk.STATEFUL_HOST_CAPABILITIES,limits:s.declaration.limits},s.adapter.capabilities);
    assert.throws(()=>sdk.canonicalStatefulRecord(foreign,'asset',{}),/Recapture/);
    await s.adapter.initialize(foreign);
    await hostSdk.executeStatefulBlock(foreign,source(s,1),s.adapter,s.custody,A,guard);
    const current=await s.adapter.open(foreign);assert.equal((await hostSdk.readStatefulRecords(foreign,s.adapter,current,[{kind:'asset',key:'one'}],guard))[0].value.owner,'bob');
    await assert.rejects(hostSdk.executeStatefulBlock(structuredClone(foreign),source(s,2),s.adapter,s.custody,async()=>{},guard),/Recapture/);
});

test('driver A/B/rollback/C preserves ordered replacements, one original image, relationships and ABA fence',async()=>{
    const s=await setup();await run(s,source(s,1),A);const a=await view(s),first=(await read(s,a)).value;
    assert.equal(first.id,'9007199254740993');assert.equal(Object.hasOwn(first.mutable,'old'),false);
    assert.equal(physical(s).images.length,2);assert.equal(physical(s).metadata.undo[0].count,2);
    await run(s,source(s,2),async p=>{const asset=(await p.get('asset','one')).value;p.put('asset','one',{...asset,owner:null,burned:true});});
    const b=await view(s);assert.equal((await read(s,b)).value.owner,null);
    const rollback={declarationDigest:s.declaration.digest,revision:b.revision,operationId:hex(50),from:b.checkpoint,ancestor:a.checkpoint,maxBlocks:1};
    assert.equal((await s.adapter.rollback(rollback)).status,'rolled-back');
    const restored=await view(s);assert.deepEqual((await read(s,restored)).value,first);
    await assert.rejects(read(s,a),code('stateful.stale-view'));await assert.rejects(read(s,b),code('stateful.stale-view'));
    await run(s,source(s,2,3),async p=>{p.put('collection','one',{name:'current'});});const c=await view(s);
    assert.deepEqual((await read(s,c)).value,first);assert.equal((await read(s,c,'collection')).value.name,'current');
    assert.equal((await s.adapter.rollback(rollback)).status,'duplicate');assert.equal((await view(s)).checkpoint.blockId,hex(3));
    const branch=await s.adapter.retainedCheckpoints(s.declaration,c.revision);assert.deepEqual(branch.checkpoints.map(p=>p.blockId),[hex(3),hex(1),hex(0)]);
});

test('canonical JSON storage preserves inert special keys, NUL/literal escapes, null and full delete/put',async()=>{
    const s=await setup(),value=JSON.parse('{"__proto__":{"safe":true},"constructor":"own","$op":"a\\u0000b","a.b":"literal\\\\u0000","nil":null,"fraction":0.1}');
    await run(s,source(s,1),async p=>{p.put('collection','x\0.$',value);p.delete('collection','x\0.$');assert.equal((await p.get('collection','x\0.$')).status,'covered-absent');p.put('collection','x\0.$',value);});
    const result=await read(s,await view(s),'collection','x\0.$');assert.deepEqual(JSON.parse(JSON.stringify(result.value)),value);assert.equal({}.safe,undefined);
    const row=physical(s).rows[0];assert.equal(typeof row.json,'string');assert.equal(Object.hasOwn(row,'__proto__'),false);assert.equal(physical(s).images.length,1);
});

for(const fault of ['before','after'])test('unknown '+fault+' commit/reconstructed adapter reuses fixed candidate without hook rerun',async()=>{
    const s=await setup();s.fixture.failTransaction=fault;let hooks=0;const hook=async p=>{hooks++;await A(p);};
    await assert.rejects(run(s,source(s,1),hook),code('stateful.apply-unavailable'));assert.equal(hooks,1);assert.equal(s.custody.retains,1);
    if(fault==='before')await assert.rejects(view(s),code('stateful.incomplete'));
    s.adapter=await createMongoDbStatefulAdapter(s.options);
    assert.equal((await run(s,source(s,1),hook)).status,fault==='before'?'applied':'duplicate');assert.equal(hooks,1);assert.equal(physical(s).metadata.receipts.length,1);
});

test('driver transaction retries receive the same plan, conflicting/expired replays do not run hooks',async()=>{
    const s=await setup();s.fixture.retryTransaction=true;let hooks=0;
    await run(s,source(s,1),async p=>{hooks++;await A(p);});assert.equal(hooks,1);assert.equal(physical(s).images.length,2);
    assert.equal((await run(s,source(s,1),async()=>{hooks++;})).status,'duplicate');
    await assert.rejects(run(s,source(s,1,99),async()=>{hooks++;}),code('stateful.replay-conflict'));assert.equal(hooks,1);
    for(let n=2;n<=6;n++)await run(s,source(s,n),async()=>{});
    await assert.rejects(run(s,source(s,1),async()=>{hooks++;}),code('stateful.receipt-unavailable'));assert.equal(hooks,1);
});

test('point reads share a native snapshot and check primary linearizable progress before/after it',async()=>{
    const s=await setup();await run(s,source(s,1),A);const old=await view(s);
    s.fixture.beforeFind=async(name,options)=>{if(options?.session&&name.includes('_r_')){
        s.fixture.beforeFind=null;await run(s,source(s,2),async p=>{p.put('collection','one',{name:'advanced'});});
    }};
    await assert.rejects(read(s,old),code('stateful.stale-view'));
    const native=s.fixture.native;
    assert.ok(native.filter(n=>n.command==='findOne'&&n.name.endsWith('_metadata')&&!n.options?.session)
        .every(n=>n.options.readPreference==='primary'&&n.options.readConcern.level==='linearizable'&&n.options.maxTimeMS===1000));
    assert.ok(native.filter(n=>n.command==='transaction').every(n=>n.options.readConcern.level==='snapshot'&&n.options.writeConcern.w==='majority'&&n.options.writeConcern.j===true));
});

test('pending intent blocks serving, different source and gap admission; original unknown candidate alone recovers',async()=>{
    const s=await setup();s.fixture.failPut=true;
    await assert.rejects(run(s,source(s,1),A),code('stateful.apply-unavailable'));
    const state=await s.adapter.recovery(s.declaration);assert.ok(state.pending);assert.equal(state.view.checkpoint.blockNum,0);assert.equal(physical(s).rows.length,0);
    await assert.rejects(view(s),code('stateful.incomplete'));
    await assert.rejects(run(s,source(s,1,88),A),code('stateful.replay-conflict'));
    await run(s,source(s,1),A);const v=await view(s),next=await sdk.captureStatefulSource(s.declaration,source(s,2));
    await s.adapter.markIncomplete(s.declaration,v,next,'selected source refused');
    await assert.rejects(view(s),code('stateful.incomplete'));await assert.rejects(run(s,source(s,1),A),code('stateful.incomplete'));
    await s.adapter.rollback({declarationDigest:s.declaration.digest,revision:v.revision,operationId:hex(60),from:v.checkpoint,ancestor:v.checkpoint,maxBlocks:1});
    assert.equal((await view(s)).checkpoint.blockNum,1);
});

test('rollback admission survives lost acknowledgment, reconstructs exact intent and refuses corrupt undo',async()=>{
    const s=await setup();await run(s,source(s,1),A);await run(s,source(s,2),async p=>{p.delete('asset','one');});const v=await view(s);
    const request={declarationDigest:s.declaration.digest,revision:v.revision,operationId:hex(70),from:v.checkpoint,ancestor:{blockNum:1,blockId:hex(1)},maxBlocks:1};
    s.fixture.failUpdate='after';await assert.rejects(s.adapter.rollback(request),code('stateful.apply-unavailable'));
    const pending=await s.adapter.recovery(s.declaration);assert.equal(pending.rollback.status,'running');assert.notEqual(pending.view.revision,v.revision);
    s.adapter=await createMongoDbStatefulAdapter(s.options);assert.equal((await s.adapter.rollback(request)).status,'rolled-back');
    assert.equal((await read(s,await view(s))).value.owner,'bob');
    const fresh=await setup();await run(fresh,source(fresh,1),A);physical(fresh).images[0].before='{}';const f=await view(fresh);
    await assert.rejects(fresh.adapter.rollback({declarationDigest:fresh.declaration.digest,revision:f.revision,operationId:hex(71),from:f.checkpoint,ancestor:{blockNum:0,blockId:hex(0)},maxBlocks:1}));
    await assert.rejects(view(fresh),code('stateful.incomplete'));
});

test('retention prunes complete blocks and reports unavailable ancestry; per-block bytes abort before effects',async()=>{
    const s=await setup(undefined,{rollbackRetentionBlocks:1});await run(s,source(s,1),A);await run(s,source(s,2),async p=>p.delete('asset','one'));
    const recovery=await s.adapter.recovery(s.declaration);assert.equal(recovery.coverage.floor.blockNum,1);assert.equal(recovery.coverage.retainedBlocks,1);
    const v=await view(s);await assert.rejects(s.adapter.rollback({declarationDigest:s.declaration.digest,revision:v.revision,operationId:hex(80),from:v.checkpoint,ancestor:{blockNum:0,blockId:hex(0)},maxBlocks:256}),code('stateful.rollback-unavailable'));
    await assert.rejects(view(s),code('stateful.incomplete'));
    const unavailable=await s.adapter.recovery(s.declaration);
    await assert.rejects(s.adapter.rollback({declarationDigest:s.declaration.digest,revision:unavailable.view.revision,operationId:hex(81),from:v.checkpoint,ancestor:v.checkpoint,maxBlocks:1}),code('stateful.rollback-unavailable'));
    const small=await setup(undefined,{rollbackMaxBlockBytes:250});await assert.rejects(run(small,source(small,1),A),code('stateful.apply-unavailable'));
    assert.equal(physical(small).rows.length,0);assert.ok((await small.adapter.recovery(small.declaration)).pending);
});

test('durable intent CAS refusal prevents effects; stale original candidate cannot adopt ordinary progress',async()=>{
    const s=await setup(),captured=await sdk.captureStatefulSource(s.declaration,source(s,1));
    const fixed=await sdk.reduceStatefulBlock(s.declaration,captured,s.adapter,A,guard);
    s.fixture.failUpdate='miss';await assert.rejects(s.adapter.apply(fixed),code('stateful.stale-view'));
    assert.equal(physical(s).rows.length,0);assert.equal(physical(s).metadata.pending,null);
    await run(s,source(s,1),async p=>p.put('collection','one',{different:true}));
    await assert.rejects(s.adapter.apply(fixed),code('stateful.replay-conflict'));
    assert.equal(physical(s).rows.length,1);assert.equal((await view(s)).revision,fixed.view.revision);
});

test('read vectors and source handles refuse getters before native I/O; host guard still owns cancellation',async()=>{
    const s=await setup();await run(s,source(s,1),A);const current=await view(s);let getters=0;
    const keys=[];Object.defineProperty(keys,0,{enumerable:true,get(){getters++;return{kind:'asset',key:'one'};}});
    const before=s.fixture.native.length;await assert.rejects(s.adapter.read(current,keys));assert.equal(getters,0);assert.equal(s.fixture.native.length,before);
    const forged={declarationDigest:s.declaration.digest,digest:hex(1),get source(){getters++;return source(s,2);}};
    await assert.rejects(s.adapter.inspect(s.declaration,forged));assert.equal(getters,0);assert.equal(s.fixture.native.length,before);
    let cancelled=false;s.fixture.beforeFind=async(name,options)=>{if(name.includes('_r_')&&options?.session){s.fixture.beforeFind=null;cancelled=true;}};
    const original=physical(s).metadata.checkpoint;
    await assert.rejects(sdk.executeStatefulBlock(s.declaration,source(s,2),s.adapter,s.custody,async p=>{await p.get('asset','one');p.delete('asset','one');},()=>{if(cancelled)throw new Error('cancelled');}),/cancelled/);
    assert.deepEqual(physical(s).metadata.checkpoint,original);assert.equal(physical(s).metadata.pending,null);
});

test('native metadata corruption cannot fabricate a different retained branch receipt',async()=>{
    const s=await setup();await run(s,source(s,1),A);physical(s).metadata.receipts[0].blockId=hex(999);
    await assert.rejects(view(s),code('stateful.invalid-contract'));
    assert.equal(physical(s).rows.length,2);
});

test('metadata envelope admits the last byte and refuses the next before native I/O or hooks',async()=>{
    const boundary=await metadataEnvelopeBoundary();assert.equal(boundary.maximum,8*1024*1024);
    assert.equal(Buffer.byteLength(boundary.reason),boundary.keyBytes);
    const accepted=await configured(undefined,{declaration:boundary.last,...boundary.policy});assert.equal(accepted.fixture.native.length,0);
    const refused=databaseFixture();
    await assert.rejects(configured(refused,{declaration:boundary.next,...boundary.policy}),code('stateful.capability-unavailable'));
    assert.equal(refused.native.length,0);
});

test('native recovery reason must fit the explicit UTF-8 key/text profile before capability exposure',async()=>{
    const bytes=Buffer.byteLength('Ancestor outside retained exact-branch undo');
    const bounds={...limits(),keyBytes:bytes},draft=await sdk.captureStatefulDeclaration(definition(),bounds);
    const accepted=await configured(undefined,{declaration:draft});assert.equal(accepted.fixture.native.length,0);
    const narrow=await sdk.captureStatefulDeclaration(definition(),{...bounds,keyBytes:bytes-1}),fixture=databaseFixture();
    await assert.rejects(configured(fixture,{declaration:narrow}),code('stateful.capability-unavailable'));assert.equal(fixture.native.length,0);
});
