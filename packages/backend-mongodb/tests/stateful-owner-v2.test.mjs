import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {definition,limits} from './stateful-fixture.mjs';
import {sdk,v1,hex,guard,configured,setup,physical,raw,admit,source,execute,takeover,retire,ownerIdentity,createMongoDbStatefulOwnerAdapterV2} from './stateful-owner-v2-fixture.mjs';
const code=value=>error=>error.code===value;
const plain=value=>JSON.parse(JSON.stringify(value));
const put=async port=>{port.put('asset','one',{id:'18446744073709551615',vector:['9007199254740993'],owner:'alice'});
    port.put('asset','one',{...(await port.get('asset','one')).value,owner:'bob'});};
async function value(s,authority=guard){const recovery=await s.adapter.recovery();return sdk.composeStatefulOwnerReadV2(s.declaration,s.adapter,s.identity,recovery.view,
    async p=>({row:await p.get('asset','one')}),authority);}

test('explicit separate owner factory/namespace neither adopts v1 nor grants public open/read readiness',async()=>{
    const s=await configured();assert.equal(s.fixture.native.length,0);assert.equal('open' in s.adapter,false);assert.equal('read' in s.adapter,false);
    assert.equal(await s.adapter.recovery(),null);
    await assert.rejects(createMongoDbStatefulOwnerAdapterV2({...s.options,declaration:s.declaration.projection}));
    const initial=await setup(s.fixture);assert.equal(physical(initial).storageVersion,'h45-stateful-mongodb-owner-v2');
    assert.equal((await initial.adapter.recovery()).raw,null);
    assert.equal(s.fixture.native.filter(n=>n.command==='createCollection').every(n=>n.options.session!==undefined),true);
    const initialize=s.fixture.native.find(n=>n.command==='transaction');assert.equal(initialize.options.readConcern.level,'local');
    assert.equal(initialize.options.writeConcern.w,'majority');assert.equal(initialize.options.writeConcern.j,true);
    await assert.rejects(initial.adapter.admitRaw({},await raw(initial,1)),code('stateful.stale-view'));
    await assert.rejects(sdk.executeStatefulOwnerBlockV2({...s.declaration},s.adapter,{},hex(1),{}, {},async()=>{},guard),/Recapture/);
});
test('raw decode failure survives reconstruction/takeover without fabricated source or changed original refs',async()=>{
    const s=await setup(),target=await admit(s,1);await s.adapter.markRawFailure(s.lease,target.digest,'decoder rejected actual input');
    let recovery=await s.adapter.recovery();assert.equal(recovery.raw.sourceDigest,null);assert.equal(recovery.gap.kind,'raw');
    assert.deepEqual(plain(recovery.raw.target),plain(target));await assert.rejects(value(s),code('stateful.incomplete'));
    const rebuilt=await createMongoDbStatefulOwnerAdapterV2(s.options),next=await takeover({...s,adapter:rebuilt});
    await assert.rejects(s.adapter.markRawFailure(s.lease,target.digest,'decoder rejected actual input'),code('stateful.stale-view'));
    await next.adapter.admitRaw(next.lease,target);assert.deepEqual(plain((await next.adapter.recovery()).raw.target),plain(target));
    await execute(next,target,put);recovery=await next.adapter.recovery();assert.equal(recovery.view.checkpoint.blockNum,1);assert.equal(recovery.gap.kind,'raw');
    await assert.rejects(value(next),code('stateful.incomplete'));await retire(next,target);
    assert.equal((await value(next)).value.row.value.owner,'bob');
});
test('unknown raw marker acknowledgment reuses the exact raw capture and refuses another target',async()=>{
    const s=await setup(),target=await raw(s,1);s.fixture.failUpdate='after';
    await assert.rejects(s.adapter.admitRaw(s.lease,target),code('stateful.apply-unavailable'));
    assert.deepEqual(plain((await s.adapter.recovery()).raw.target),plain(target));const writes=s.fixture.native.filter(n=>n.command==='update').length;
    await s.adapter.admitRaw(s.lease,target);assert.equal(s.fixture.native.filter(n=>n.command==='update').length,writes);
    const foreign=await sdk.captureStatefulRawTargetV2(s.declaration,{...target.target,rawSource:{...target.target.rawSource,selectionId:'different-certified-reference'}});
    await assert.rejects(s.adapter.admitRaw(s.lease,foreign),code('stateful.replay-conflict'));
});
test('owner acquisition lost CAS acknowledgment has one exact claim retry; stale expectations cannot steal it',async()=>{
    const s=await setup(),recovery=await s.adapter.recovery(),request={expected:{version:recovery.version,view:recovery.view,owner:recovery.owner},nextOwner:ownerIdentity('two')};
    s.fixture.failUpdate='after';await assert.rejects(s.adapter.acquireOwner(request,guard),code('stateful.apply-unavailable'));
    const lease=await s.adapter.acquireOwner(structuredClone(request),guard);assert.ok(lease);
    await assert.rejects(s.adapter.acquireOwner({...request,nextOwner:ownerIdentity('three')},guard),code('stateful.stale-view'));
    await assert.rejects(s.adapter.retainedCheckpoints(s.lease),code('stateful.stale-view'));
});
for(const phase of ['before','after'])test(`unknown ${phase} commit recovers original candidate on cold owner without hook rerun`,async()=>{
    const s=await setup(),target=await admit(s,1);let hooks=0;s.fixture.failTransaction=phase;
    await assert.rejects(execute(s,target,async p=>{hooks++;await put(p);}),code('stateful.apply-unavailable'));
    const held=await s.adapter.recovery();assert.equal(held.raw.target.digest,target.digest);assert.equal(held.view.checkpoint.blockNum,phase==='after'?1:0);
    const next=await takeover({...s,adapter:await createMongoDbStatefulOwnerAdapterV2(s.options)});
    const result=await execute(next,target,async()=>{hooks++;throw new Error('reran hook');});
    assert.equal(hooks,1);assert.equal(result.status,phase==='after'?'duplicate':'applied');await retire(next,target);
    assert.equal((await value(next)).value.row.value.id,'18446744073709551615');
});
test('failed original pending candidate keeps gap through retry and exact apply-before-clear repair',async()=>{
    const s=await setup(),target=await admit(s,1);s.fixture.failTransaction='before';await assert.rejects(execute(s,target,put));
    const original=[...s.custody.entries.values()][0];await s.adapter.markSourceFailure(s.lease,target.digest,original.source.digest,'uncertain effect acknowledgment');
    assert.ok((await s.adapter.recovery()).pending);await assert.rejects(value(s),code('stateful.incomplete'));
    await execute(s,target,async()=>{throw new Error('candidate missing');});assert.ok((await s.adapter.recovery()).gap);
    s.fixture.failUpdate='after';await assert.rejects(retire(s,target),code('stateful.apply-unavailable'));
    assert.equal((await s.adapter.recovery()).raw,null);await retire(s,target);
    await assert.rejects(s.adapter.retireRaw(s.lease,hex(999),original.source.digest,original.digest),code('stateful.receipt-unavailable'));
    const next=await takeover(s);await assert.rejects(next.adapter.retireRaw(next.lease,target.digest,original.source.digest,original.digest),code('stateful.receipt-unavailable'));
    assert.equal((await value(next)).value.row.value.owner,'bob');
});
test('normal inflight completed reads require actual live-owner guard and never leak reduction capability',async()=>{
    const s=await setup(),first=await admit(s,1);await execute(s,first,put);await retire(s,first);const old=(await s.adapter.recovery()).view;
    const target=await admit(s,2);let live=true;const authority=()=>{if(!live)throw new Error('host live-owner authority closed');};
    const cap=await s.adapter.completedRead(s.identity,old,authority);assert.equal((await s.adapter.readCompleted(cap,old,[{kind:'asset',key:'one'}])).results[0].value.owner,'bob');
    await assert.rejects(s.adapter.reductionView(cap),code('stateful.unavailable'));await assert.rejects(s.adapter.completedView({...cap}),code('stateful.unavailable'));
    live=false;await assert.rejects(s.adapter.completedView(cap),/authority closed/);live=true;s.adapter.closeRead(cap);await assert.rejects(s.adapter.completedView(cap),code('stateful.unavailable'));
    await s.adapter.markRawFailure(s.lease,target.digest,'raw packet failed');await assert.rejects(s.adapter.completedRead(s.identity,old,authority),code('stateful.incomplete'));
});
test('owner cancellation while native read is held prevents later effect/transaction starts',async()=>{
    const s=await setup(),target=await admit(s,1);let live=true;const next=await takeover(s,'held',()=>{if(!live)throw new Error('actual owner fenced');});
    const start=s.fixture.native.length;s.fixture.beforeFind=async(name)=>{if(name.endsWith('_metadata')){s.fixture.beforeFind=null;live=false;}};
    await assert.rejects(execute(next,target,put),/actual owner fenced/);
    assert.equal(s.fixture.native.slice(start).some(n=>['transaction','update','insert','replace','delete'].includes(n.command)),false);
});
test('rollback uses original undo engine, invalidates old leases/read caps and cannot clear cross-declaration recovery',async()=>{
    const s=await setup(),first=await admit(s,1);await execute(s,first,put);await retire(s,first);const atOne=(await s.adapter.recovery()).view;
    const second=await admit(s,2);await execute(s,second,async p=>p.delete('asset','one'));await retire(s,second);const current=(await s.adapter.recovery()).view;
    const cap=await s.adapter.completedRead(s.identity,current,guard),request={declarationDigest:s.declaration.digest,revision:current.revision,
        operationId:hex(90),from:current.checkpoint,ancestor:atOne.checkpoint,maxBlocks:1};
    const rolled=await s.adapter.rollbackOwned(s.lease,request);assert.equal(rolled.status,'rolled-back');assert.notEqual(rolled.recovery.view.revision,current.revision);
    await assert.rejects(s.adapter.retainedCheckpoints(s.lease),code('stateful.stale-view'));await assert.rejects(s.adapter.completedView(cap),code('stateful.stale-view'));
    const next=await takeover(s);assert.equal((await next.adapter.rollbackOwned(next.lease,request)).status,'duplicate');
    assert.equal((await value(next)).value.row.value.owner,'bob');
    await assert.rejects(next.adapter.rollbackOwned(next.lease,{...request,declarationDigest:hex(999)}));
});
test('native raw/view/source mismatch and oversized locators fail before domain effects',async()=>{
    const s=await setup(),target=await raw(s,1),before=s.fixture.native.length;
    await assert.rejects(sdk.captureStatefulRawTargetV2(s.declaration,{...target.target,rawSource:{...target.target.rawSource,commitId:'x'.repeat(1025)}}));
    assert.equal(s.fixture.native.length,before);await s.adapter.admitRaw(s.lease,target);
    const {captureStatefulSourceV2}=await import('@eosrio/hyperion-sdk/projection-stateful-source-v2');
    const foreign=await captureStatefulSourceV2(s.declaration,{...source(target),block:{...source(target).block,blockId:hex(2)}});
    await assert.rejects(s.adapter.bindSource(s.lease,target.digest,foreign),code('stateful.replay-conflict'));
    assert.equal((await s.adapter.recovery()).raw.sourceDigest,null);
});
test('lost rollback-admission ACK resumes with fresh owner and original operation revision',async()=>{
    const s=await setup(),target=await admit(s,1);await execute(s,target,put);await retire(s,target);const view=(await s.adapter.recovery()).view;
    const request={declarationDigest:s.declaration.digest,revision:view.revision,operationId:hex(91),from:view.checkpoint,ancestor:{blockNum:0,blockId:hex(0)},maxBlocks:1};
    s.fixture.failUpdate='after';await assert.rejects(s.adapter.rollbackOwned(s.lease,request),code('stateful.apply-unavailable'));
    const recovery=await s.adapter.recovery();assert.equal(recovery.rollback.status,'running');assert.notEqual(recovery.view.revision,view.revision);
    await assert.rejects(s.adapter.retainedCheckpoints(s.lease),code('stateful.stale-view'));
    const next=await takeover({...s,adapter:await createMongoDbStatefulOwnerAdapterV2(s.options)});
    assert.equal((await next.adapter.rollbackOwned(next.lease,request)).status,'rolled-back');
    assert.equal((await value(next)).value.row.status,'covered-absent');
});
test('closing a held private capability drains the current read and starts no further keyed read',async()=>{
    const s=await setup(),target=await admit(s,1);await execute(s,target,put);await retire(s,target);const view=(await s.adapter.recovery()).view;
    const cap=await s.adapter.completedRead(s.identity,view,guard);let reached=false;
    s.fixture.beforeFind=async(name)=>{if(name.includes('_r_')){s.fixture.beforeFind=null;reached=true;s.adapter.closeRead(cap);}};
    const before=s.fixture.native.length;
    await assert.rejects(s.adapter.readCompleted(cap,view,[{kind:'asset',key:'one'},{kind:'asset',key:'two'}]),code('stateful.unavailable'));
    assert.equal(reached,true);assert.equal(s.fixture.native.slice(before).filter(n=>n.command==='findOne'&&n.name.includes('_r_')).length,1);
    const foreign=await createMongoDbStatefulOwnerAdapterV2(s.options);await assert.rejects(foreign.completedView(cap),code('stateful.unavailable'));
});
test('pending-intent CAS miss prevents all domain effects and raw metadata corruption refuses on cold inspection',async()=>{
    const s=await setup(),target=await admit(s,1),{captureStatefulSourceV2}=await import('@eosrio/hyperion-sdk/projection-stateful-source-v2');
    await s.adapter.bindSource(s.lease,target.digest,await captureStatefulSourceV2(s.declaration,source(target)));
    const before=s.fixture.native.length;s.fixture.failUpdate='miss';await assert.rejects(execute(s,target,put),code('stateful.stale-view'));
    assert.equal(s.fixture.native.slice(before).some(n=>['replace','delete','insert'].includes(n.command)),false);
    const m=physical(s);m.raw.target.target.rawSource.observationDigest=hex(999);
    await assert.rejects(s.adapter.recovery(),/Raw target capture differs/);
});
test('actual owner execution/custody preserves scope-less KV identities including zero bytes and key-only secondary rows',async()=>{
    const selected=definition();selected.selectors[0].kind='table';const projection=await v1.captureStatefulDeclaration(selected,limits());
    const s=await setup(undefined,{projection}),target=await admit(s,1),input=source(target),selector=projection.definition.selectors[0],binding=projection.definition.binding;
    const identities=[{kind:'kv-primary',tableId:0,keyHex:'000001'},{kind:'kv-secondary',tableId:65535,secondaryKeyHex:'',primaryKeyHex:'0000'}];
    input.inputs=identities.map((identity,order)=>{const rawHex='000'+String(order+1);return {selector:selector.id,order,kind:'table',contract:selector.contract,name:selector.name,
        abiDeployment:selector.abiDeployment,abiSha256:selector.abiSha256,mappingRevision:binding.mappingRevision,codecRevision:binding.codecRevision,normalizerRevision:binding.normalizerRevision,
        rawHex,rawSha256:createHash('sha256').update(Buffer.from(rawHex,'hex')).digest('hex'),sourceEvidence:hex(100),
        data:order===0?{owner:'original-kv-owner'}:null,transactionId:null,identity,payer:null,present:true,deltaOrdinal:0,rowOrdinal:order};});
    await sdk.executeStatefulOwnerBlockV2(s.declaration,s.adapter,s.lease,target.digest,input,s.custody,async port=>{
        assert.deepEqual(plain(port.source.inputs.map(row=>row.identity)),identities);assert.equal(port.source.inputs[1].data,null);
        assert.equal(Object.hasOwn(port.source.inputs[0],'scope'),false);port.put('asset','one',{id:'1',vector:[],owner:port.source.inputs[0].data.owner});
    },guard);
    const candidate=await retire(s,target);assert.equal(candidate.source.sourceInputVersion,2);assert.equal((await value(s)).value.row.value.owner,'original-kv-owner');
    for(const transaction of s.fixture.native.filter(n=>n.command==='transaction').slice(1)){
        assert.equal(transaction.options.readConcern.level,'snapshot');assert.equal(transaction.options.writeConcern.w,'majority');assert.equal(transaction.options.writeConcern.j,true);
    }
    await assert.rejects(v1.captureStatefulSource(projection,input));
});
for(const mode of ['bootstrap','takeover'])test(`exact ${mode} acquire retry cannot silently adopt a rollback revision`,async()=>{
    let s=await setup(),request={expected:null,nextOwner:s.identity};
    if(mode==='takeover'){
        const recovery=await s.adapter.recovery();request={expected:{version:recovery.version,view:recovery.view,owner:recovery.owner},nextOwner:ownerIdentity('takeover')};
        s={...s,identity:request.nextOwner,lease:await s.adapter.acquireOwner(request,guard)};
    }
    const target=await admit(s,1);await execute(s,target,put);await retire(s,target);
    assert.ok(await s.adapter.acquireOwner(structuredClone(request),guard),'ordinary progress permits exact same-revision claim retry');
    const view=(await s.adapter.recovery()).view;
    await s.adapter.rollbackOwned(s.lease,{declarationDigest:s.declaration.digest,revision:view.revision,operationId:hex(92),from:view.checkpoint,ancestor:view.checkpoint,maxBlocks:1});
    await assert.rejects(s.adapter.acquireOwner(structuredClone(request),guard),code('stateful.stale-view'));
    const next=await takeover(s,'fresh-after-rollback');assert.equal((await value(next)).value.row.value.owner,'bob');
});
