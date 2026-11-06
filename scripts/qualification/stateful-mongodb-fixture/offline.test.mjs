import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {validateManifest,validatePrior,PHASES,priorPhase,ADAPTER_HEAD,SDK_HEAD,hash,stable} from './guard.mjs';
import {runPhase,verifyUndoInventory} from './runner.mjs';

// Deliberately constructed pure input. No real PID/socket/module/replica identity is claimed.
function manifest() {
    const caseId='h45_stateful_0123456789ab',caseRoot='/opt/hapi329/stateful-qualification/'+caseId;
    const entries={sdk:'host-sdk/dist/projection-stateful.js',adapterSdk:'node_modules/@eosrio/hyperion-sdk/dist/projection-stateful.js',adapter:'dist/stateful.js',driver:'node_modules/mongodb/lib/index.js',runner:'qualification/runner.mjs',guard:'qualification/guard.mjs'};
    return {schemaVersion:1,caseId,caseRoot,databaseName:caseId,collectionPrefix:'case_0123456789ab',
        uri:'mongodb://127.0.0.1:37123/?replicaSet='+caseId+'&directConnection=true',
        server:{replicaSet:caseId,replicaSetId:'0'.repeat(24),member:'127.0.0.1:37123',version:'8.2.0',failpointBaselineCount:0},
        owner:{pid:123,birthTicks:'1234',executable:'/usr/bin/mongod',executableSha256:'a'.repeat(64),cmdlineSha256:'b'.repeat(64),netNamespace:'net:[123]',socketInode:'456'},
        runtime:{version:'v24.19.0',executableSha256:'c'.repeat(64)},modules:{root:caseRoot+'/component',entries,
            files:Object.values(entries).map(path=>({path,bytes:123,sha256:'d'.repeat(64)}))},input:{path:caseRoot+'/plan.json',bytes:1024,sha256:'e'.repeat(64)},
        bounds:{phaseMS:60000,operationMS:1000,transactionMS:10000,candidateBytes:1048576,maxRecords:32,outputBytes:16384,moduleFiles:1000,moduleBytes:10000000,moduleFileBytes:1000000},
        policy:{receiptRetention:2,rollbackRetentionBlocks:2,rollbackRetentionBytes:2097152,rollbackMaxBlockBytes:1048576},adapterHead:ADAPTER_HEAD,sdkHead:SDK_HEAD};
}
test('pure complete configuration accepts explicitly constructed inputs without native imports or clients',()=>{
    assert.equal(validateManifest(manifest()).schemaVersion,1);assert.equal(typeof runPhase,'function');
});
for(const uri of ['mongodb://example.com:37123/','mongodb://localhost:37123/','mongodb+srv://127.0.0.1/','mongodb://[::1]:37123/',
    'mongodb://127.0.0.1:27017/','mongodb://user:secret@127.0.0.1:37123/','mongodb://127.0.0.1:37123/production',
    'mongodb://127.0.0.1:37123/?replicaSet=wrong&directConnection=true',
    'mongodb://127.0.0.1:37123/?replicaSet=h45_stateful_0123456789ab&directConnection=true&tls=true'])
    test('remote/default/credentialed/ambiguous URI refuses: '+uri.replace(/user:secret/,'redacted'),()=>{const m=manifest();m.uri=uri;assert.throws(()=>validateManifest(m));});
test('database, collection, replica, source pins and unknown fields cannot widen target',()=>{
    for(const mutate of [m=>m.databaseName='production',m=>m.collectionPrefix='anything',m=>m.caseRoot+='/../other',m=>m.server.member='127.0.0.1:37124',
        m=>m.adapterHead='a'.repeat(40),m=>m.sdkHead='b'.repeat(40),m=>m.extra=true]){const m=manifest();mutate(m);assert.throws(()=>validateManifest(m));}
});
test('module inventory is exact, bounded, local and binds every executable entry',()=>{
    for(const mutate of [m=>m.modules.files.pop(),m=>m.modules.files.push(m.modules.files[0]),m=>m.modules.files[0].path='../outside',
        m=>m.modules.files[0].path='/outside',m=>m.modules.files[0].bytes=Number.MAX_SAFE_INTEGER,m=>m.modules.entries.driver='https://example.com/code.mjs',
        m=>m.modules.files[0].sha256='not-a-pin',m=>m.modules.files[0].path='node_modules\\outside',m=>m.modules.root='/',
        m=>m.modules.files[0].sha256='f'.repeat(64),m=>m.modules.entries.sdk=m.modules.entries.adapterSdk]){const m=manifest();mutate(m);assert.throws(()=>validateManifest(m));}
});
test('explicit time/output/record/retention bounds and pinned native majors refuse invalid profiles',()=>{
    for(const mutate of [m=>delete m.bounds.operationMS,m=>m.bounds.phaseMS=120001,m=>m.bounds.transactionMS=m.bounds.phaseMS,m=>m.bounds.outputBytes=65537,
        m=>m.bounds.maxRecords=129,m=>m.policy.rollbackRetentionBlocks=3,m=>m.runtime.version='v22.0.0',m=>m.owner.pid=0]){
        const m=manifest();mutate(m);assert.throws(()=>validateManifest(m));}
});
test('phase prerequisites require exact preceding completed case evidence',()=>{
    assert.deepEqual(PHASES,['a','fail-b','recover-b','fork-c','retention']);assert.equal(priorPhase('a'),null);
    for(const phase of PHASES.slice(1)){
        const receipt={phase:priorPhase(phase),status:'passed',manifestSha256:'a'.repeat(64),actualMongo:true,engineCrash:false};
        assert.equal(validatePrior(receipt,phase,'a'.repeat(64)),receipt);
        for(const bad of [{...receipt,status:'running'},{...receipt,phase},{...receipt,actualMongo:false},{...receipt,engineCrash:true}])assert.throws(()=>validatePrior(bad,phase,'a'.repeat(64)));
        assert.throws(()=>validatePrior(receipt,phase,'b'.repeat(64)));
    }
});
test('committed synthetic plan preserves special JSON distinctions without claiming authority',()=>{
    const b=readFileSync(new URL('./plan.json',import.meta.url)),p=JSON.parse(b);
    assert.equal(hash(b).length,64);assert.equal(p.assetKey,'asset\0.$');assert.equal(p.asset.id,'9007199254740993');
    assert.equal(p.asset['a.b'],'a\0b');assert.equal(p.asset.$op,'literal\\u0000');assert.ok(Object.hasOwn(p.asset,'__proto__'));
    assert.equal(p.asset.nil,null);assert.ok(!Object.hasOwn(p.asset,'missing'));assert.equal({}.inert,undefined);
    assert.equal(stable(JSON.parse(stable(p))),stable(p));
});

// Source-derived BSON sizing for these tiny constructed test documents only. Runtime uses
// the pinned driver's public BSON serializer; this is neither a driver nor an engine test.
function offlineBsonSize(object) {
    let bytes=5;
    for(const [key,value] of Object.entries(object)) {
        assert.ok(!key.includes('\0'));bytes+=1+Buffer.byteLength(key)+1;
        if(value===null)continue;
        if(typeof value==='string')bytes+=4+Buffer.byteLength(value)+1;
        else if(typeof value==='number'){assert.ok(Number.isInteger(value)&&value>=-2147483648&&value<=2147483647);bytes+=4;}
        else {assert.ok(typeof value==='object');bytes+=offlineBsonSize(value);}
    }
    return bytes;
}
const clone=value=>JSON.parse(JSON.stringify(value));
function undoFixture(stage) {
    const plan=JSON.parse(readFileSync(new URL('./plan.json',import.meta.url)));
    const hex=n=>n.toString(16).padStart(64,'0');
    const blocks={A:{blockNum:1,blockId:hex(1),previousBlockId:hex(0)},B:{blockNum:2,blockId:hex(2),previousBlockId:hex(1)},
        C:{blockNum:2,blockId:hex(3),previousBlockId:hex(1)},D:{blockNum:3,blockId:hex(4),previousBlockId:hex(3)},E:{blockNum:4,blockId:hex(5),previousBlockId:hex(4)}};
    const candidates=Object.fromEntries(Object.entries(blocks).map(([label,block],i)=>[label,{digest:hex(100+i),source:{digest:hex(200+i),source:{block}}}]));
    const image=(label,kind,key,before)=>({_id:hash(blocks[label].blockId+hash(JSON.stringify([kind,key]))),blockId:blocks[label].blockId,
        target:{key,kind},before:before===null?null:stable(before)});
    const images={A:[image('A','asset',plan.assetKey,null),image('A','collection',plan.collectionKey,null)],
        B:[image('B','asset',plan.assetKey,plan.asset),image('B','collection',plan.collectionKey,plan.collection),image('B','temporary',plan.temporaryKey,null)],
        C:[image('C','collection',plan.collectionKey,plan.collection)],D:[],E:[]};
    const retained={A:['A'],B:['A','B'],C:['A','C'],D:['C','D'],E:['D','E']}[stage],floorLabel={A:null,B:null,C:null,D:'A',E:'C'}[stage];
    const point=block=>({blockNum:block.blockNum,blockId:block.blockId});
    const receipt=label=>({...point(blocks[label]),sourceDigest:candidates[label].source.digest,candidateDigest:candidates[label].digest});
    const undo=retained.map(label=>{const ordered=[...images[label]].sort((a,b)=>a._id<b._id?-1:a._id>b._id?1:0);
        return {block:blocks[label],digest:candidates[label].digest,sourceDigest:candidates[label].source.digest,count:ordered.length,
            imageBytes:ordered.reduce((sum,image)=>sum+offlineBsonSize(image),0),imagesHash:hash(JSON.stringify(ordered))};});
    const policy={receiptRetention:2,rollbackRetentionBlocks:2,rollbackRetentionBytes:2097152,rollbackMaxBlockBytes:1048576};
    const floor=floorLabel?point(blocks[floorLabel]):{blockNum:0,blockId:hex(0)},checkpoint=point(blocks[stage]);
    const p={images:retained.flatMap(label=>images[label]),metadata:{undo,checkpoint,revision:hex(300),floor,
        floorReceipt:floorLabel?receipt(floorLabel):null,receipts:retained.map(receipt)}};
    const recovery={view:{revision:p.metadata.revision,checkpoint},coverage:{floor,retainedBlocks:undo.length,
        retainedBytes:offlineBsonSize({undo})-offlineBsonSize({undo:[]})+undo.reduce((n,u)=>n+u.imageBytes,0),
        maxBlocks:policy.rollbackRetentionBlocks,maxBytes:policy.rollbackRetentionBytes}};
    return {p,plan,stage,candidates,policy,recovery,images,check:()=>verifyUndoInventory(p,plan,stage,candidates,offlineBsonSize,policy,recovery)};
}
test('independent undo oracle accepts the five exact constructed retained branches',()=>{
    for(const stage of ['A','B','C','D','E'])assert.doesNotThrow(undoFixture(stage).check);
});
test('public SDK detached null-prototype recovery DTOs preserve exact JSON coverage comparisons',()=>{
    const detached=value=>value!==null&&typeof value==='object'?Object.assign(Object.create(null),
        Object.fromEntries(Object.entries(value).map(([key,child])=>[key,detached(child)]))):value;
    for(const stage of ['A','B','C','D','E']){const f=undoFixture(stage);
        assert.doesNotThrow(()=>verifyUndoInventory(f.p,f.plan,stage,f.candidates,offlineBsonSize,f.policy,detached(f.recovery)));}
});
test('rolled-back B images prevent an accepted A or replacement C physical snapshot',()=>{
    for(const stage of ['A','C']){const f=undoFixture(stage);f.p.images.push(...f.images.B);assert.throws(f.check);}
});
test('floor-pruned A and C images prevent an accepted final retention snapshot',()=>{
    for(const label of ['A','C']){const f=undoFixture('E');f.p.images.push(...f.images[label]);assert.throws(f.check);}
});
test('every retained image must have the original plan block, exact target, key identity and before-value',()=>{
    for(const mutate of [f=>f.p.images.pop(),f=>f.p.images.push(clone(f.p.images[0])),
        f=>f.p.images[0]._id='f'.repeat(64),f=>f.p.images[0].before=stable({owner:'bob'}),
        f=>f.p.images[0].target.key='different',f=>f.p.images[0].blockId='f'.repeat(64),
        f=>f.p.images[0].extra='unexpected']){const f=undoFixture('B');mutate(f);assert.throws(f.check);}
});
test('exact undo descriptors reject stale blocks, count, original image bytes/hash and source/candidate identities',()=>{
    for(const mutate of [f=>f.p.metadata.undo.pop(),f=>f.p.metadata.undo[1].count++,f=>f.p.metadata.undo[1].imageBytes++,
        f=>f.p.metadata.undo[1].imagesHash='f'.repeat(64),f=>f.p.metadata.undo[1].digest='f'.repeat(64),
        f=>f.p.metadata.undo[1].sourceDigest='f'.repeat(64),f=>f.p.metadata.undo[1].block.previousBlockId='f'.repeat(64),
        f=>f.p.metadata.undo.reverse()]){const f=undoFixture('B');mutate(f);assert.throws(f.check);}
});
test('pruning retains the independently expected floor, receipt, ordered empty-block descriptors and coherent coverage bytes',()=>{
    for(const mutate of [f=>f.p.metadata.floor.blockNum--,f=>f.p.metadata.floorReceipt.candidateDigest='f'.repeat(64),
        f=>f.p.metadata.receipts.pop(),f=>f.p.metadata.receipts.reverse(),f=>f.recovery.coverage.retainedBytes++,
        f=>f.recovery.coverage.retainedBlocks--,f=>f.recovery.coverage.maxBytes--,f=>f.recovery.view.revision='f'.repeat(64),
        f=>f.recovery.view.checkpoint={blockNum:3,blockId:'f'.repeat(64)}]){const f=undoFixture('E');mutate(f);assert.throws(f.check);}
});
