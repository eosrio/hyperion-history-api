import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {boundedCanonicalJson} from '../../build/indexer/helpers/bounded-json.js';

const schema=Buffer.from(JSON.parse(readFileSync(new URL('../unit/fixtures/wire-native-genesis/ship-preflight-20261020.json',import.meta.url))).schema.base64,'base64').toString('utf8');
const long='雪𝄞"\\\n\u0000'.repeat(200);
const encoded=value=>JSON.stringify(value);
test('repeated actual Wire schema encoding preserves exact bytes and every later caller byte bound',()=>{
    const expected=encoded(schema),bytes=Buffer.byteLength(expected);
    assert.equal(boundedCanonicalJson(schema),expected);
    for(let index=0;index<4;index++){
        assert.equal(boundedCanonicalJson(schema,{maximumBytes:bytes}),expected);
        assert.throws(()=>boundedCanonicalJson(schema,{maximumBytes:bytes-1,errorPrefix:'Later caller'}),{message:'Later caller exceeds bounded JSON byte budget'});
        assert.equal(boundedCanonicalJson([schema],{maximumBytes:bytes+2}),'['+expected+']');
        assert.throws(()=>boundedCanonicalJson([schema],{maximumBytes:bytes+1}),/bounded JSON byte budget/);
    }
});

test('escaped Unicode, controls and surrogate refusal keep their original JSON and error semantics',()=>{
    const values=[long,...Array.from({length:64},(_,index)=>(String.fromCharCode(index)+String.fromCodePoint(0x10000+index)+'"\\').repeat(160))];
    for(const value of values){const expected=encoded(value),bytes=Buffer.byteLength(expected);
        assert.equal(boundedCanonicalJson(value,{maximumBytes:bytes}),expected);
        assert.equal(boundedCanonicalJson(value,{maximumBytes:bytes}),expected);
        assert.throws(()=>boundedCanonicalJson(value,{maximumBytes:bytes-1}),/bounded JSON byte budget/);
    }
    for(const value of ['\ud800','\udfff','"'.repeat(1024)+'\ud800'])
        assert.throws(()=>boundedCanonicalJson(value,{maximumBytes:1,errorPrefix:'Malformed'}),{message:'Malformed contains malformed UTF-16'});
});

test('encoding reuse grants no object validation, source view or numeric-policy shortcut',()=>{
    boundedCanonicalJson(long);
    const value={schema:long,version:1};assert.equal(boundedCanonicalJson(value),'{"schema":'+encoded(long)+',"version":1}');
    Object.defineProperty(value,'schema',{get(){throw Error('Accessor must not run');},enumerable:true});
    assert.throws(()=>boundedCanonicalJson(value),/accessors or sparse data/);
    const cyclic={schema:long};cyclic.self=cyclic;assert.throws(()=>boundedCanonicalJson(cyclic),/not portable JSON/);
    assert.equal(boundedCanonicalJson([long,1.5],{numberPolicy:'finite'}),'['+encoded(long)+',1.5]');
    assert.throws(()=>boundedCanonicalJson([long,1.5]),/not portable JSON/);
});

test('the actual emitted encoding cache remains within its finite byte and entry bounds',()=>{
    const source=readFileSync(new URL('../../build/indexer/helpers/bounded-json.js',import.meta.url),'utf8');
    const observed=new Function('createHash',source.replace(/^import .*?;\r?\n/gm,'').replace('export function boundedCanonicalJson','function boundedCanonicalJson')+
        '\nreturn {encode:boundedCanonicalJson,snapshot:()=>({entries:encodedStrings.size,bytes:retainedEncodingBytes,rows:[...encodedStrings.values()].map(row=>({bytes:row.bytes,retained:row.retained})),maximumEntries:encodingCacheEntries,maximumBytes:encodingCacheBytes,maximumEntryBytes:encodingEntryBytes})};')(createHash);
    for(let index=0;index<40;index++){
        const value=String(index)+'"雪'.repeat(8000);assert.equal(observed.encode(value),encoded(value));
        const current=observed.snapshot();assert(current.entries<=current.maximumEntries);assert(current.bytes<=current.maximumBytes);
        assert.equal(current.bytes,current.rows.reduce((sum,row)=>sum+row.retained,0));assert(current.rows.every(row=>row.bytes<=current.maximumEntryBytes));
    }
    const before=observed.snapshot();observed.encode('"'.repeat(100000));assert.deepEqual(observed.snapshot(),before,'Oversized encodings must never enter the cache');
});


test('known ineligible lengths and caller byte bounds never hash or probe the cache',()=>{
    const source=readFileSync(new URL('../../build/indexer/helpers/bounded-json.js',import.meta.url),'utf8');
    let probes=0,hashes=0;
    class ObservedMap extends Map {get(key){probes++;return super.get(key);}}
    const observeHash=(...args)=>{hashes++;return createHash(...args);};
    const encode=new Function('Map','createHash',source.replace(/^import .*?;\r?\n/gm,'').replace('export function boundedCanonicalJson','function boundedCanonicalJson')+'\nreturn boundedCanonicalJson;')(ObservedMap,observeHash);
    for(const value of ['"'.repeat(65535),'雪'.repeat(32768),'"'.repeat(1024*1024),long]) {
        assert.throws(()=>encode(value,{maximumBytes:64}),/bounded JSON byte budget/);
        assert.equal(probes,0);assert.equal(hashes,0);
    }
    assert.equal(encode('雪'.repeat(32768)),JSON.stringify('雪'.repeat(32768)));
    assert.equal(probes,0);assert.equal(hashes,0,'UTF-8-ineligible values must not hash even when the caller permits them');
});

test('one-off and churning strings retain digest-only entries before repeat admission',()=>{
    const source=readFileSync(new URL('../../build/indexer/helpers/bounded-json.js',import.meta.url),'utf8');
    const observed=new Function('createHash',source.replace(/^import .*?;\r?\n/gm,'').replace('export function boundedCanonicalJson','function boundedCanonicalJson')+'\nreturn {encode:boundedCanonicalJson,rows:()=>[...encodedStrings.entries()]};')(createHash);
    for(let index=0;index<32;index++)assert.equal(observed.encode(schema+' unique '+index),JSON.stringify(schema+' unique '+index));
    assert(observed.rows().every(([key,row])=>key.length===64&&row.state==='pending'&&row.input===undefined&&row.encoded===undefined&&row.retained===128));
    observed.encode(long);observed.encode(long);
    assert(observed.rows().some(([,row])=>row.state==='encoded'&&row.input===long&&row.encoded===JSON.stringify(long)));
});

test('digest collisions cannot reuse bytes for a different primitive value',()=>{
    const source=readFileSync(new URL('../../build/indexer/helpers/bounded-json.js',import.meta.url),'utf8');
    const collisionHash=()=>({update(){return this;},digest(){return 'a'.repeat(64);}});
    const encode=new Function('createHash',source.replace(/^import .*?;\r?\n/gm,'').replace('export function boundedCanonicalJson','function boundedCanonicalJson')+'\nreturn boundedCanonicalJson;')(collisionHash);
    for(const value of [long,long,schema,schema,long,schema])assert.equal(encode(value),JSON.stringify(value));
});

test('plain ASCII and hex retain the original fast path with no hashing, cache lookup or changed budget/error precedence',()=>{
 const source=readFileSync(new URL('../../build/indexer/helpers/bounded-json.js',import.meta.url),'utf8');let hashes=0,probes=0;
 class ObservedMap extends Map{get(key){probes++;return super.get(key);}}
 const encode=new Function('Map','createHash',source.replace(/^import .*?;\r?\n/gm,'').replace('export function boundedCanonicalJson','function boundedCanonicalJson')+'\nreturn boundedCanonicalJson;')(ObservedMap,(...args)=>{hashes++;return createHash(...args);});
 for(const length of [511,512,32768,65534,65535])for(let i=0;i<4;i++){
  const value=('ab0123456789'.repeat(Math.ceil(length/12))).slice(0,length-1)+String(i),expected=JSON.stringify(value),bytes=Buffer.byteLength(expected);
  assert.equal(encode(value,{maximumBytes:bytes}),expected);assert.equal(encode(value,{maximumBytes:bytes}),expected);
  assert.throws(()=>encode(value,{maximumBytes:bytes-1,errorPrefix:'Plain'}),{message:'Plain exceeds bounded JSON byte budget'});
  assert.equal(encode([value],{maximumBytes:bytes+2}),'['+expected+']');assert.throws(()=>encode([value],{maximumBytes:bytes+1}),/bounded JSON byte budget/);
 }
 for(const value of ['a'.repeat(512)+'\ud800','b'.repeat(65534)+'\udfff'])assert.throws(()=>encode(value,{maximumBytes:1,errorPrefix:'Malformed'}),{message:'Malformed contains malformed UTF-16'});
 assert.equal(hashes,0);assert.equal(probes,0);
});
