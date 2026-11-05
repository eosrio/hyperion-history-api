// Pure gate for separately obtained and independently pinned original PG artifacts.
// An unqualified or unpinned report can never become source/HTTP authority.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function verifyOriginalReports({pins,read,readArchive,check}){
 assert.equal(pins?.schemaVersion,1);assert.equal(pins?.repository,'eosrio/hyperion-atomicassets-plugin');assert.equal(pins?.runId,'42014752481');assert.equal(typeof readArchive,'function');assert.equal(pins?.reference,'0aabc47dcf8bd0804d4dcecb336c90fc02a9c89e');assert.match(pins.head,/^[a-f0-9]{40}$/);assert.match(pins.tree,/^[a-f0-9]{40}$/);
 assert(Array.isArray(pins.reports)&&pins.reports.length>=2&&pins.reports.length<=4);assert.equal(typeof read,'function');assert.equal(typeof check,'function');
 const ids=new Set(),runtimes=new Set(),out=[];
 for(const pin of pins.reports){assert.equal(typeof pin.file,'string');assert(/^[a-zA-Z0-9_.-]+\.json$/.test(pin.file));assert(!ids.has(pin.file));ids.add(pin.file);assert.match(pin.sha256,/^[a-f0-9]{64}$/);
  assert(/^[a-zA-Z0-9_.-]+\.zip$/.test(pin.archive));assert.match(pin.artifactId,/^[0-9]+$/);assert.match(pin.archiveSha256,/^[a-f0-9]{64}$/);const archive=Buffer.from(readArchive(pin.archive));assert(archive.length<=16*1024*1024);assert.equal(sha(archive),pin.archiveSha256);const bytes=Buffer.from(read(pin.file));assert(bytes.length<=8*1024*1024);assert.equal(bytes.length,pin.bytes);assert.equal(sha(bytes),pin.sha256);const report=JSON.parse(bytes.toString('utf8'));
  assert.equal(report.plugin.head,pins.head);assert.equal(report.plugin.tree,pins.tree);assert.equal(report.reference.commit,pins.reference);assert.equal(report.status,'passed');assert.equal(report.qualified,false);assert.equal(check(report).captureComplete,true);
  const node=report.runtime.node;assert.match(node,/^v(?:24|26)\./);runtimes.add(node.slice(1,3));out.push({file:pin.file,sha256:pin.sha256,report});
 }
 assert.deepEqual([...runtimes].sort(),['24','26']);const events=out[0].report.events.filter(e=>e.kind==='royalty-callback-input');assert.equal(events.length,4);
 const responses=out[0].report.result.responses;for(const row of out.slice(1)){assert.deepEqual(row.report.events.filter(e=>e.kind==='royalty-callback-input'),events);
  assert.equal(row.report.result.responses.length,responses.length);for(let i=0;i<responses.length;i++){const a=responses[i],b=row.report.result.responses[i];for(const k of ['name','route','query','body','method','status'])assert.deepEqual(a[k],b[k]);
   if(a.method!=='HEAD'){const x=JSON.parse(a.rawText),y=JSON.parse(b.rawText);delete x.query_time;delete y.query_time;assert.deepEqual(x,y);}}}
 return {reports:out,events,responses};
}
