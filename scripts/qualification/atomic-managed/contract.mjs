// Pure owned-Linux plan and invocation contract. No clients, timers, children or Docker effects.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const PROFILE='managed-atomic77-hapi-cbfb-linux-engineering-v1';
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const PLAN=freeze({schemaVersion:1,profile:PROFILE,qualificationOnly:true,
 atomic:{commit:'1bc686bd7ed7d433b2cb7c3a04a762c0c832ad97',tree:'db9a1c22fab23d118567588fdc3132e278f133c3'},
 sdk:{root:'cbfb26694b90b52266d1e0b9b5dbf6f8389e736b',native:'cbfb26694b90b52266d1e0b9b5dbf6f8389e736b'},
 mixedHistoricalSource:'c1b98a52a872b6c070ada32243c8286607e86883',sdk49HistoricalSource:'e19fc9afc391512ec3ad620a387c41d80982e3d3',
 fixture:{server:'8.0.34',image:'docker.io/library/mongo@sha256:4c7d0fb8fde0681e2ae443b0b09371ec9c31a81caab05af9579458bfcb30d656',nanoCPUs:2000000000,memoryBytes:1073741824,childDeadlineMS:300000,graceMS:10000,terminalMS:10000},
 operationMS:5000,transactionMS:15000,httpMS:5000,traceEvents:16384,evidenceBytes:32*1024*1024,
 cases:{ownedSnapshots:8,royaltySuccesses:10,royaltyCandidateRefusals:6,lateOwner:true,lateCoverage:true,genesisRefused:true},
 acceptance:{scope:'controlled-source-managed-HTTP-only',sourceAuthority:'controlled-synthetic-only',fullAtomicParity:'pending',productionOffers:'empty',WireAuthority:'none'}});
export function argumentsFor(argv,environment){
 assert.equal(argv.length,14);for(const [index,key]of ['--profile','--database','--output','--source','--assembly-sha256','--atomic-root','--replica-set'].entries())assert.equal(argv[index*2],key);
 const [profile,database,output,source,assemblySha256,atomicRoot,replicaSet]=argv.filter((_,index)=>index%2===1);assert.equal(profile,PROFILE);
 assert.match(database,/^h45_indexed_[a-f0-9]{12}$/);assert.match(source,/^[a-f0-9]{40}$/);assert.match(assemblySha256,/^[a-f0-9]{64}$/);assert(output&&atomicRoot);assert.match(replicaSet,/^h45rs_[a-f0-9]{32}$/);
 const uri=environment.HYPERION_MANAGED_ATOMIC_MONGO_URI,parsed=new URL(uri);assert.equal(parsed.protocol,'mongodb:');assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.username+parsed.password+parsed.hash,'');assert(['','/'].includes(parsed.pathname));
 assert(Number.isInteger(Number(parsed.port))&&Number(parsed.port)>=1024&&Number(parsed.port)<=65535&&parsed.port!=='27017');
 assert.deepEqual([...parsed.searchParams.keys()].sort(),['directConnection','replicaSet']);assert.equal(parsed.searchParams.get('directConnection'),'true');assert.equal(parsed.searchParams.get('replicaSet'),replicaSet);
 return {profile,database,output,source,assemblySha256,atomicRoot,replicaSet,uri,member:'hyp-projection-'+replicaSet.slice(6)+'-replica:27017'};
}
export function assertChildTerminal(terminal){assert.deepEqual(terminal,{code:0,signal:null,timedOut:false,terminal:true,streamsClosed:true},'Original managed child did not complete successfully');}
export function assertCompletion(terminal,report,assemblySha256){
 assertChildTerminal(terminal);assert.equal(report.status,'passed-controlled-managed-http-only');assert.equal(report.profile,PROFILE);assert.equal(report.assemblySha256,assemblySha256);
 assert.equal(report.result.snapshots.length,8);assert.equal(report.result.royalty.successes.length,10);assert.equal(report.result.royalty.refusals.length,6);assert.equal(report.result.royalty.invalidStatus,400);assert.equal(report.result.lateOwnerRefused,true);assert.equal(report.result.lateCoverageRefused,true);assert.equal(report.result.restoredCoverage,true);
 for(const key of ['httpClosed','clientsClosed','sessionsEnded','readsClosed','cursorsClosed','databaseDropped'])assert.equal(report.cleanup[key],true,key);
 assert.deepEqual(report.acceptance,PLAN.acceptance);assert(report.queries>0&&report.traceEvents>0&&report.traceEvents<=PLAN.traceEvents);
}
export function persistChildIntent(input,persist){
 assert.deepEqual(Object.keys(input).sort(),['executable','argv','cwd','source','runtime','limits','environment'].sort());assert.equal(input.argv.length,15);assert.equal(typeof input.executable,'string');assert.equal(typeof input.cwd,'string');
 const selected=argumentsFor(input.argv.slice(1),input.environment);assert.equal(selected.source,input.source);assert.equal(selected.assemblySha256,input.limits.assemblySha256);
 const intent=Object.freeze({schemaVersion:1,status:'intent-only',...input});assert.equal(persist(intent),undefined);return intent;
}
