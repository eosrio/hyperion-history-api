import assert from 'node:assert/strict';
import test from 'node:test';
import {Long} from 'mongodb';
import {planMongoIndexedQueryV1,encodeMongoIndexedRowsV1} from '../dist/stateful-indexed-model-v1.js';
import {readMongoIndexedCursorV1} from '../dist/stateful-indexed-cursor-v1.js';
import {prepared,page,count,schema,collection,assets,totals} from './indexed-schema-fixture.mjs';
const nativeRow=(s,asset)=>({base:encodeMongoIndexedRowsV1(s.native,{kind:'schema',key:'one'},schema())[0],joined:{
 collection:[encodeMongoIndexedRowsV1(s.native,{kind:'collection',key:'c'},collection())[0]],
 assets:asset===undefined?[]:[encodeMongoIndexedRowsV1(s.native,{kind:'schema-asset-count',key:'a'},assets(asset))[0]]}});
async function run(s,request,batches,available=totals()){
 let attempts=0;const commands=[],killed=[];
 const result=await readMongoIndexedCursorV1(s.native,planMongoIndexedQueryV1(s.native,request,'rows'),{database:'inert',collection:'rows',view:s.view,available,
  operationTimeoutMS:1000,attempts:()=>attempts,async command(value){commands.push(value);attempts++;if(attempts>available.readAttempts)throw new Error('attempt allowance');
   const next=batches.shift();if(next instanceof Error)throw next;assert(next,'unexpected command');return {cursor:{id:next.id??Long.ZERO,ns:next.ns??'inert.rows',[attempts===1?'firstBatch':'nextBatch']:next.rows}};},
  async cleanup(id){killed.push(id.toString());}});
 return {result,commands,killed};
}
test('full page still requires getMore exhaustion and counts every native data attempt',async()=>{
 const s=await prepared(),r=await run(s,page({limit:1}),[{id:Long.ONE,rows:[nativeRow(s)]},{rows:[]}]);
 assert.equal(r.commands.length,2);assert.equal(r.result.attempts,2);assert.equal(r.commands[1].getMore.toString(),'1');assert.equal(r.commands[0].allowDiskUse,false);assert.deepEqual(r.killed,[]);
});
test('missing aggregate remains null while an actual zero remains the exact string zero',async()=>{
 const s=await prepared();for(const value of [undefined,'0','9007199254740993']){
  const {result}=await run(s,page(),[{rows:[nativeRow(s,value)]}]);assert.equal(result.result.rows[0].fields.assets,value??null);
  assert.equal(result.result.rows[0].records.assets===null,value===undefined);
 }
});
test('empty count is exact zero and full int64 native count retains its decimal bytes',async()=>{
 const s=await prepared();assert.equal((await run(s,count(),[{rows:[]}])).result.result.value,'0');
 assert.equal((await run(s,count(),[{id:Long.ONE,rows:[{_id:null,value:Long.MAX_VALUE,invalid:Long.ZERO}]},{rows:[]}])).result.result.value,'9223372036854775807');
});
test('native number counts, overflow, duplicate counts and invalid join counters refuse',async()=>{
 const s=await prepared();for(const rows of [[{_id:null,value:1,invalid:Long.ZERO}],[{_id:null,value:Long.NEG_ONE,invalid:Long.ZERO}],
 [{_id:null,value:Long.ONE,invalid:Long.ONE}],[{_id:null,value:Long.ONE,invalid:Long.ZERO},{_id:null,value:Long.ONE,invalid:Long.ZERO}]])await assert.rejects(run(s,count(),[{rows}]));
});
test('duplicate/foreign joined rows, corrupt sidecars and missing required joins refuse',async()=>{
 const s=await prepared();for(const mutate of [r=>r.joined.collection=[],r=>r.joined.collection.push(r.joined.collection[0]),
 r=>r.joined.collection[0]={...r.joined.collection[0],key:'wrong'},r=>r.base={...r.base,v:{...r.base.v,created:Long.ZERO}},r=>r.extra=true]){
  const row=nativeRow(s);mutate(row);await assert.rejects(run(s,page(),[{rows:[row]}]));
 }
});
test('cursor identity/namespace/batch overflow and post-window extra rows refuse with cleanup',async()=>{
 const s=await prepared();for(const batches of [[{id:Long.ONE,ns:'other.rows',rows:[]}],[{id:Long.ONE,rows:[nativeRow(s),nativeRow(s)]}],
 [{id:Long.ONE,rows:[nativeRow(s)]},{id:Long.fromInt(2),rows:[]}],[{id:Long.ONE,rows:[nativeRow(s)]},{rows:[nativeRow(s)]}]])await assert.rejects(run(s,page({limit:1}),batches));
});
test('native attempts, response records and entire success envelope bytes are enforced',async()=>{
 const s=await prepared();await assert.rejects(run(s,page(),[{id:Long.ONE,rows:[nativeRow(s)]},{rows:[]}],{...totals(),readAttempts:1}));
 await assert.rejects(run(s,page(),[{rows:[nativeRow(s)]}],{...totals(),responseRecords:0}));
 await assert.rejects(run(s,count(),[{rows:[]}],{...totals(),responseBytes:20}));
});
test('a data failure remains primary if cursor cleanup also fails',async()=>{
 const s=await prepared(),original=new Error('original data failure');let calls=0,killed=0;
 await assert.rejects(readMongoIndexedCursorV1(s.native,planMongoIndexedQueryV1(s.native,page(),'rows'),{database:'inert',collection:'rows',view:s.view,available:totals(),operationTimeoutMS:1000,attempts:()=>calls,
  async command(){if(++calls===1)return {cursor:{id:Long.ONE,ns:'inert.rows',firstBatch:[]}};throw original;},async cleanup(){killed++;throw new Error('cleanup failure');}}),error=>error===original);
 assert.equal(killed,1);
});
