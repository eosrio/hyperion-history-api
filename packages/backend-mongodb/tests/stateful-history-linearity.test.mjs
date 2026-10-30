/** Fresh metadata validation only; these synthetic vectors grant no source or serving authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertStatefulHistory} from '../dist/stateful-contract.js';
import {sdk,definition,limits} from './stateful-fixture.mjs';

const hex=n=>n.toString(16).padStart(64,'0');
const declaration=await sdk.captureStatefulDeclaration(definition(),limits());
const policy={receiptRetention:256,maxBlockBytes:8*1024*1024};
const empty=createHash('sha256').update('[]').digest('hex');
function history(n,counter) {
    const undo=Array.from({length:n},(_,index)=>{
        const blockNum=index+1,block={blockNum,blockId:hex(blockNum),previousBlockId:hex(index)};
        return {block:counter?new Proxy(block,{get(value,key){if(key==='blockNum')counter.reads++;return Reflect.get(value,key);}}):block,
            digest:hex(blockNum+1000),sourceDigest:hex(blockNum+2000),count:0,imageBytes:0,imagesHash:empty};
    });
    return {floor:{blockNum:0,blockId:hex(0)},floorReceipt:null,checkpoint:{blockNum:n,blockId:hex(n)},undo,
        receipts:undo.map((u,index)=>({blockNum:index+1,blockId:hex(index+1),candidateDigest:u.digest,sourceDigest:u.sourceDigest}))};
}
test('fresh retained receipt matching has a linear scalar-read bound through the default256 window',()=>{
    const measurements=[];
    for(const retained of [8,32,64,128,256]) {
        const counter={reads:0};assertStatefulHistory(declaration,policy,history(retained,counter));
        measurements.push({retained,reads:counter.reads});
        assert.ok(counter.reads<=8*retained,JSON.stringify({retained,reads:counter.reads,maximum:8*retained}));
    }
    console.log(JSON.stringify({metadataValidationOnly:true,linearBound:8,measurements}));
});
test('fresh receipt lookup preserves floor, original identities and all malformed-history refusals',()=>{
    const value=history(8),floor=structuredClone(value);
    floor.floor={blockNum:1,blockId:hex(1)};floor.floorReceipt=floor.receipts[0];floor.undo.shift();
    assert.doesNotThrow(()=>assertStatefulHistory(declaration,policy,floor));
    for(const [label,change,pattern]of [
        ['receipt order',m=>m.receipts.reverse(),/Retained receipt order differs/],
        ['receipt block identity',m=>m.receipts[2].blockId=hex(999),/Receipt is not on the retained branch/],
        ['candidate identity',m=>m.receipts[2].candidateDigest=hex(999),/Receipt and undo disagree/],
        ['source identity',m=>m.receipts[2].sourceDigest=hex(999),/Receipt and undo disagree/],
        ['undo height',m=>m.undo[2].block.blockNum=2,/Undo branch\/count\/byte identity differs/],
        ['undo digest',m=>m.undo[2].digest='invalid',/Expected SHA-256/],
        ['floor identity',m=>m.floor.blockId=hex(999),/Undo branch\/count\/byte identity differs/],
        ['progress',m=>m.checkpoint.blockNum++,/Undo branch does not end at progress/]]) {
        const changed=structuredClone(value);change(changed);
        assert.throws(()=>assertStatefulHistory(declaration,policy,changed),pattern,label);
    }
    let invoked=0;const accessor=structuredClone(value);
    Object.defineProperty(accessor.undo[0],'digest',{enumerable:true,get(){invoked++;return hex(1001);}});
    assert.throws(()=>assertStatefulHistory(declaration,policy,accessor),/Unexpected fields\/accessors/);assert.equal(invoked,0);
});
