import assert from 'node:assert/strict';
import test from 'node:test';
import {Long} from 'mongodb';
import {captureIndexedDeclarationV1} from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import {assertMongoIndexedTracerModelV1,encodeMongoIndexedRowsV1,decodeMongoIndexedRowV1,mongoIndexedIndexesV1,assertMongoIndexedIndexesV1,
 planMongoIndexedQueryV1,receiveMongoIndexedModelV1} from '../dist/stateful-indexed-model-v1.js';
import {prepared,page,count,schema,collection,model,totals} from './indexed-schema-fixture.mjs';

test('typed representation preserves canonical JSON and signed int64 above Number precision',async()=>{
 const s=await prepared(),row=encodeMongoIndexedRowsV1(s.native,{kind:'schema',key:'one'},schema())[0];
 assert(Long.isLong(row.v.created));assert.equal(row.v.created.toString(),'9007199254740993');assert.equal(decodeMongoIndexedRowV1(s.native,'schema',row).value.created_at_time,'9007199254740993');
 assert.equal(row.joins.collection,JSON.stringify(['atomicassets','collection']));assert.equal(row.joins.assets,JSON.stringify(['atomicassets','collection','one']));
 assert.notEqual(row.json,JSON.stringify({...schema(),created_at_time:9007199254740992}));
});
test('wrong digest, foreign owner and mutated received model are rejected by local recapture',async()=>{
 const s=await prepared();await assert.rejects(receiveMongoIndexedModelV1(s.owner,{...s.declaration,digest:'f'.repeat(64)},totals()));
 await assert.rejects(receiveMongoIndexedModelV1(s.owner,{...s.declaration,ownerDeclarationDigest:'f'.repeat(64)},totals()));
 const bad=structuredClone(s.declaration);bad.model.fields[0].path=['other'];await assert.rejects(receiveMongoIndexedModelV1(s.owner,bad,totals()));
});
test('corrupted typed fields, null flags, aliases and canonical JSON refuse instead of repairing',async()=>{
 const s=await prepared(),row=encodeMongoIndexedRowsV1(s.native,{kind:'schema',key:'one'},schema())[0];
 for(const bad of [{...row,v:{...row.v,created:Long.ONE}},{...row,n:{...row.n,created:1}},{...row,kind:'collection'},
  {...row,representation:'old'},{...row,json:row.json+' '},{...row,joins:{...row.joins,assets:'wrong'}}])assert.throws(()=>decodeMongoIndexedRowV1(s.native,'schema',bad));
});
test('native model refuses unimplemented comparator/predicate/order before planning or data work',async()=>{
 for(const change of [m=>m.fields[2].operators.push('text-contains'),m=>m.orders.push([{field:'assets',direction:'asc',nulls:'last'}]),
  m=>m.fields[4].operators.push('array-contains')]){const m=model();change(m);const s=await prepared({model:m});assert.throws(()=>assertMongoIndexedTracerModelV1(s.native));}
});
test('schema page uses equality access path, native order, joins before int64 offset/limit and no spill',async()=>{
 const s=await prepared(),q=page({offset:'9007199254740993',where:[{field:'contract',op:'eq',value:'atomicassets'},
 {field:'collection',op:'in',values:['collection']},{field:'schema',op:'not-in',values:[]},{field:'created',op:'gte',value:'9007199254740993'}]}),p=planMongoIndexedQueryV1(s.native,q,'sidecar');
 assert.equal(p.allowDiskUse,false);assert(p.hint.startsWith('h45_ix_b_'));assert.deepEqual(p.pipeline[1],{$sort:{'n.created':1,'v.created':-1}});
 const skip=p.pipeline.findIndex(x=>x.$skip);assert.equal(p.pipeline[skip].$skip.toString(),'9007199254740993');assert(Long.isLong(p.pipeline[skip].$skip));
 assert(p.pipeline.findIndex(x=>x.$lookup)>1);assert(p.pipeline.findIndex(x=>x.$match?.['lookups.collection.0'])<skip);
 assert.equal(p.pipeline.filter(x=>x.$lookup).length,2);assert(p.pipeline.every(x=>!x.$function&&!x.$where));
});
test('count uses the same match/join membership and a native exact Long sum without page/order',async()=>{
 const s=await prepared(),p=planMongoIndexedQueryV1(s.native,page(),'sidecar'),c=planMongoIndexedQueryV1(s.native,count(),'sidecar');
 assert.deepEqual(c.pipeline[0],p.pipeline[0]);assert.deepEqual(c.pipeline.slice(1,-1),p.pipeline.slice(2,-3));
 assert(Long.isLong(c.pipeline.at(-1).$group.value.$sum));assert.equal(c.pipeline.at(-1).$group.value.$sum.toString(),'1');
 assert(c.pipeline.every(x=>!x.$skip&&!x.$sort&&!x.$limit));
});
test('empty membership stays explicit and unanchored/unsupported native requests refuse before I/O',async()=>{
 const s=await prepared(),p=planMongoIndexedQueryV1(s.native,page({where:[{field:'contract',op:'eq',value:'atomicassets'},{field:'schema',op:'in',values:[]}]}),'s');
 assert.deepEqual(p.pipeline[0].$match.$and.at(-1),{'v.schema':{$in:[]}});
 assert.throws(()=>planMongoIndexedQueryV1(s.native,page({where:[]}),'s'));
 assert.throws(()=>planMongoIndexedQueryV1(s.native,page({where:[{field:'schema',op:'text-contains',value:'x'}]}),'s'));
});
test('index admission rejects hidden, wrong-key, partial, sparse and wrong comparison indexes',async()=>{
 const s=await prepared(),valid=mongoIndexedIndexesV1(s.native).map(x=>({name:x.name,key:x.key,unique:x.unique,...(x.partial?{partialFilterExpression:x.partial}:{})}));
 assertMongoIndexedIndexesV1(s.native,valid);
 for(const mutate of [x=>x[0].hidden=true,x=>x[0].sparse=true,x=>x[0].key={wrong:1},x=>x[0].collation={locale:'en'},
 x=>x[0].partialFilterExpression={alias:'schema'},x=>x.pop()]){const bad=structuredClone(valid);mutate(bad);assert.throws(()=>assertMongoIndexedIndexesV1(s.native,bad));}
});
test('missing/wrong stored fields never coerce and join equality admits only stored text',async()=>{
 const s=await prepared();for(const value of [{...schema(),created_at_time:'01'},{...schema(),created_at_time:9},{...schema(),schema_name:null},
 {...schema(),collection_name:[]},{...collection(),authorized_accounts:[1]}])assert.throws(()=>encodeMongoIndexedRowsV1(s.native,{kind:'schema',key:'x'},value));
 const changed=structuredClone(model());changed.joins[0].on[0].basePath=['format'];const d=await captureIndexedDeclarationV1(s.owner,'other',changed),native=await receiveMongoIndexedModelV1(s.owner,d,totals());
 assert.throws(()=>encodeMongoIndexedRowsV1(native,{kind:'schema',key:'x'},schema()));
});
