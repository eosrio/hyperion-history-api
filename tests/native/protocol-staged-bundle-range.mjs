/** Isolated full-range component control; synthetic payload/ES and sampled instrumentation, no service. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {frontierMemoryClient} from '../unit/protocol-frontier-memory.mjs';
import {ImmutableProtocolBundleStore} from '../../build/indexer/protocol/immutable-bundle-store.js';
const mode=process.argv[2];assert.ok(['sequential','staged'].includes(mode));assert.equal(process.versions.bun,undefined);
const recordBytes=128*1024*1024,memory=frontierMemoryClient(1),store=new ImmutableProtocolBundleStore(memory.client,'fixture',1,'range','range-v1');
let record={payload:'x'.repeat(recordBytes-14)};const expected=createHash('sha256').update(record.payload).digest('hex');
await store.prepare('range:128m',record);record=null;memory.calls.length=0;globalThis.gc?.();
const manifest=memory.documents.get(memory.key(store.index,'range:128m')).document;
let responseJsonBytes=0,maxResponseJsonBytes=0;const peak={rss:0,heapUsed:0,external:0,arrayBuffers:0};
const sample=()=>{const m=process.memoryUsage();for(const k of Object.keys(peak))peak[k]=Math.max(peak[k],m[k]);};
const observe=r=>{const bytes=Buffer.byteLength(JSON.stringify(r));responseJsonBytes+=bytes;maxResponseJsonBytes=Math.max(maxResponseJsonBytes,bytes);sample();return r;};
memory.faults.read=observe;memory.faults.mget=observe;const getIndex=memory.client.indices.get.bind(memory.client.indices);
memory.client.indices.get=async(...args)=>observe(await getIndex(...args));sample();const before=process.memoryUsage(),cpu=process.cpuUsage(),started=performance.now();
const value=mode==='sequential'?await store.read('range:128m'):(await store.readMany(['range:128m'],recordBytes))[0];
sample();assert.equal(value.payload.length,recordBytes-14);assert.equal(createHash('sha256').update(value.payload).digest('hex'),expected);
const requests=memory.calls.length,requestJsonBytes=memory.calls.reduce((sum,c)=>sum+Buffer.byteLength(JSON.stringify(c.request)),0);
console.log(JSON.stringify({passed:true,node:process.version,mode,recordBytes,chunks:manifest.chunk_ids.length,requests,requestJsonBytes,responseJsonBytes,maxResponseJsonBytes,
 elapsedMs:performance.now()-started,cpuMicroseconds:process.cpuUsage(cpu),before,sampledPeak:peak,processMaxRssKiB:process.resourceUsage().maxRSS,
 instrumentation:'method JSON byte counters and memory samples include wrapper overhead; maxRSS covers setup and read',controlledTransport:true,actualEngine:false,fullWire:false,hardRssCapClaim:false}));
