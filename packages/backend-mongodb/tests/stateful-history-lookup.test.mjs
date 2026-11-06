import test from 'node:test'; import assert from 'node:assert/strict';
import {assertStatefulHistory as candidate} from '../dist/stateful-contract.js';
const h=n=>n.toString(16).padStart(64,'0'), zero={blockNum:0,blockId:h(0)}, d={limits:{mutations:10}}, policy={receiptRetention:512,maxBlockBytes:100000};
function fixture(n){let prev=zero; const undo=[],receipts=[]; for(let i=1;i<=n;i++){const block={blockNum:i,blockId:h(i),previousBlockId:prev.blockId};undo.push({block,digest:h(i+10000),sourceDigest:h(i+20000),count:0,imageBytes:0,imagesHash:h(i+30000)});receipts.push({blockNum:i,blockId:h(i),sourceDigest:h(i+20000),candidateDigest:h(i+10000)});prev=block;}return {floor:zero,floorReceipt:null,undo,receipts,checkpoint:{blockNum:n,blockId:h(n)}};}
function outcome(fn,m){try{fn(d,policy,m);return 'ok'}catch(e){return `${e.code}:${e.message}`}}
test('valid histories and corrupt branches, identities, receipts and bounds are freshly checked',()=>{
 const valid=[fixture(0),fixture(1),fixture(64)];
 const floor=fixture(4);floor.floor={blockNum:1,blockId:h(1)};floor.floorReceipt=floor.receipts[0];floor.undo=floor.undo.slice(1);valid.push(floor);
 for(const m of valid) assert.equal(outcome(candidate,m),'ok');
 for(const change of [m=>m.undo[1].block.previousBlockId=h(99),m=>m.undo[1].block.blockId=m.undo[0].block.blockId,m=>m.checkpoint.blockId=h(99),m=>m.receipts[1].sourceDigest=h(99),m=>m.receipts[1].candidateDigest=h(99),m=>m.receipts[1].blockId=h(99),m=>m.receipts[1].blockNum=1,m=>m.floorReceipt=m.receipts[0]]) {const m=fixture(4);change(m);assert.notEqual(outcome(candidate,m),'ok');}
 const sameHeight=fixture(2);sameHeight.receipts[0].blockId=h(999);assert.notEqual(outcome(candidate,sameHeight),'ok');
 assert.throws(()=>candidate(d,{...policy,receiptRetention:3},fixture(4)),e=>e.code==='stateful.invalid-contract');
 assert.throws(()=>candidate(d,{...policy,maxBlockBytes:1},fixture(1)),e=>e.code==='stateful.invalid-contract');
 const m=fixture(4);assert.equal(outcome(candidate,m),'ok');m.receipts[1].sourceDigest=h(999);assert.notEqual(outcome(candidate,m),'ok');
});
test('retained undo index reads grow linearly',()=>{
 const counts=[];for(const n of [32,64,128]) {const m=fixture(n);let reads=0;m.undo=new Proxy(m.undo,{get(t,k,r){if(typeof k==='string' && /^\d+$/.test(k))reads++;return Reflect.get(t,k,r)}});assert.equal(outcome(candidate,m),'ok');counts.push(reads);}
 console.log('undo numeric index reads',counts);assert.ok(counts[1]<=counts[0]*2+2);assert.ok(counts[2]<=counts[1]*2+2);
});
