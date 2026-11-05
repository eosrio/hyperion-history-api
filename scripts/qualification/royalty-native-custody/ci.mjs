// Stop-capable owned Linux/GHA controller. NEVER execute/import on Windows or from pure controls.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createWriteStream,readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {release} from 'node:os';
import {MongoClient} from 'mongodb';
import {OwnedMongoFixture,MONGODB_IMAGE,MONGODB_VERSION,waitForMongo} from '../projection-fixture.mjs';
import {terminalChild} from '../stateful-complete-kind-mongodb/ci.mjs';
import {afterReadiness} from '../operator-list-mongodb/contract.mjs';
import {verifyCursorClosure,verifyIndexedTrace} from '../indexed-schema-mongodb/cbfb-native-trace.mjs';
import {PLAN,PROFILE,sha,assertChildTerminal,assertCompletion} from './contract.mjs';
import {verifyOriginalReports} from './original.mjs';import {verifyCustodyArtifacts} from './verify-artifacts.mjs';import {BSON} from 'mongodb';import {createRequire} from 'node:module';
import {admitCustodyAssembly} from './admission.mjs';import {root,PROFILE_PATH} from '../atomic-managed-wire34-cbfb/assembly.mjs';
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
export async function runCI(profile,atomicRoot,pgRoot,pgReports,output){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(realpathSync(process.env.GITHUB_WORKSPACE),realpathSync(root));assert.equal(profile,PROFILE);
 atomicRoot=realpathSync(atomicRoot);pgRoot=realpathSync(pgRoot);pgReports=realpathSync(pgReports);output=resolve(output);assert(output!==resolve(root)&&!relative(root,output).startsWith('..'));assert(!existsSync(output));mkdirSync(output,{recursive:true});
 const report={schemaVersion:1,profile,status:'running',plan:PLAN,kernel:release(),acceptance:PLAN.acceptance};let fixture,child,primary,hasPrimary=false;
 const retainPrimary=error=>{if(!hasPrimary){hasPrimary=true;primary=error;}}; const safeFailure=error=>{try{return{name:String(error?.name??'Error'),message:String(error?.message??error),...(typeof error?.stack==='string'?{stack:error.stack}:{})};}catch{return{name:'Error',message:'Failure details unavailable'};}};
 const stop=()=>{retainPrimary(new Error('Managed Atomic controller interrupted'));child?.kill('SIGTERM');},check=()=>{if(hasPrimary)throw primary;};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  check();report.assembly=await admitCustodyAssembly(atomicRoot);const pins=JSON.parse(readFileSync(new URL('./pg-pins.json',import.meta.url)));const pgGit=(...args)=>execFileSync('git',args,{cwd:pgRoot,encoding:'utf8',timeout:10000}).trim();assert.equal(pgGit('rev-parse','HEAD'),pins.head);assert.equal(pgGit('rev-parse','HEAD^{tree}'),pins.tree);assert.equal(pgGit('status','--porcelain=v1','--untracked-files=all'),'');const pgCheck=createRequire(join(pgRoot,'package.json'))('./harness/atomicassets/postgres/royalty-rule-gate.cjs').check;const original=verifyOriginalReports({pins,read:file=>readFileSync(join(pgReports,file)),readArchive:file=>readFileSync(join(pgReports,file)),check:pgCheck});report.originalPins=pins;const git=(base,args)=>execFileSync('git',args,{cwd:base,encoding:'utf8',windowsHide:true}).trim(),source=process.env.GITHUB_SHA;
  assert.match(source,/^[a-f0-9]{40}$/);report.checkout={commit:git(root,['rev-parse','HEAD']),tree:git(root,['rev-parse','HEAD^{tree}']),workflowSha:process.env.GITHUB_WORKFLOW_SHA,
   runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,job:process.env.GITHUB_JOB};assert.equal(report.checkout.commit,source);
  const sourcePaths=['src','packages/backend-mongodb','package.json','package-lock.json','tsconfig.json','.bun-version','scripts/qualification/atomic-managed-wire34-cbfb','scripts/qualification/royalty-native-custody','tests/native/atomic-managed-wire34-cbfb-sdk-boundary.test.mjs','tests/native/atomic-managed-wire34-cbfb-host-publication.test.mjs','tests/native/atomic-managed-wire34-cbfb-result-observer.test.mjs','tests/native/atomic-managed-wire34-cbfb-teardown.test.mjs','.github/workflows/atomic-managed-wire34-cbfb.yml',PROFILE_PATH];
  assert.equal(git(root,['status','--porcelain=v1','--untracked-files=all','--',...sourcePaths]),'','Unreviewed HAPI managed source');assert.equal(git(atomicRoot,['status','--porcelain=v1','--untracked-files=all','--','src','harness','fixtures','tests/fixtures','scripts/qualification/owned-schema-mongodb','scripts/qualification/royalty-template-mongodb','package.json','package-lock.json']),'','Unreviewed Atomic source');
  assert.equal(MONGODB_IMAGE,PLAN.fixture.image);assert.equal(MONGODB_VERSION,PLAN.fixture.server);
  // Complete observed source/runtime/GHA identity precedes every Docker effect.
  check();fixture=new OwnedMongoFixture();report.run=fixture.run;report.cleanup=fixture.cleanupResult;
  const kernel=fixture.command(['info','--format','{{.KernelVersion}}']),version=/^(\d+)\.(\d+)\.(\d+)/.exec(kernel);report.dockerKernel=kernel;
  assert(!version||!(Number(version[1])===6&&Number(version[2])>=19||Number(version[1])===7&&Number(version[2])===0&&Number(version[3])<14),'MongoDB8.0.34 kernel constraint');
  check();fixture.prepare();check();const uri=fixture.start('replica');
  const ready=async primary=>{const client=await waitForMongo(()=>{check();return new MongoClient(uri,{directConnection:true,retryReads:false,retryWrites:false,maxAdaptiveRetries:0,maxPoolSize:1,serverSelectionTimeoutMS:1000,connectTimeoutMS:1000});},{primary,replicaSet:fixture.replicaSet,timeoutMS:60000});await client.close();check();};
  await afterReadiness(check,()=>ready(false),()=>fixture.initializeReplica());
  report.child=await afterReadiness(check,()=>ready(true),()=>{
   const owned=fixture.ownedContainer('replica'),image=fixture.inspect('image',MONGODB_IMAGE);assert.equal(image.Os,'linux');assert.equal(image.Architecture,'amd64');assert.equal(owned.Image,image.Id);assert.equal(owned.HostConfig.NanoCpus,PLAN.fixture.nanoCPUs);assert.equal(owned.HostConfig.Memory,PLAN.fixture.memoryBytes);
   report.container={id:owned.Id,name:owned.Name,labels:owned.Config.Labels,imageId:image.Id,repoDigests:image.RepoDigests,replicaSet:fixture.replicaSet,volume:fixture.volume.name,cpus:owned.HostConfig.NanoCpus,memory:owned.HostConfig.Memory,memorySwap:owned.HostConfig.MemorySwap,port:owned.NetworkSettings.Ports};
   const runner=fileURLToPath(new URL('./runner.mjs',import.meta.url)),argv=[runner,'--profile',PROFILE,'--database','h45_indexed_'+fixture.run.slice(0,12),'--output',join(output,'native'),'--source',source,'--assembly-sha256',report.assembly.managedSha256,'--atomic-root',atomicRoot,'--replica-set',fixture.replicaSet,'--pg-root',pgRoot,'--pg-reports',pgReports],
    invocation={schemaVersion:1,status:'intent-only',executable:process.execPath,argv,cwd:root,source,runtime:report.assembly.runtime,limits:{fixture:PLAN.fixture,assemblySha256:report.assembly.managedSha256},environment:{HYPERION_MANAGED_ATOMIC_MONGO_URI:uri+'&replicaSet='+fixture.replicaSet}};json(join(output,'child-intent.json'),invocation);
   report.childInvocation=invocation;check();child=spawn(invocation.executable,invocation.argv,{cwd:invocation.cwd,stdio:['ignore','pipe','pipe'],env:{...process.env,...invocation.environment}});if(Number.isSafeInteger(child.pid)&&child.pid>0)report.childProcess={pid:child.pid};
   return terminalChild(child,createWriteStream(join(output,'runner.stdout.log'),{flags:'wx'}),createWriteStream(join(output,'runner.stderr.log'),{flags:'wx'}),{deadlineMS:PLAN.fixture.childDeadlineMS,graceMS:PLAN.fixture.graceMS,terminalMS:PLAN.fixture.terminalMS});
  });
  if(report.childProcess)json(join(output,'child-process.json'),report.childProcess);json(join(output,'child-terminal.json'),report.child);check();assertChildTerminal(report.child);
  const native=JSON.parse(readFileSync(join(output,'native/report.json'),'utf8'));assertCompletion(report.child,native,report.assembly.managedSha256);assert.equal(native.runtime.node,process.version);assert.equal(native.runtime.sha256,report.assembly.runtime.sha256);
  const sums=JSON.parse(readFileSync(join(output,'native/sha256.json'),'utf8'));assert.deepEqual(sums.map(row=>row.path).sort(),['answers.json','events.json','report.json','trace.json']);
  for(const row of sums){const bytes=readFileSync(join(output,'native',row.path));assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);}
  const trace=JSON.parse(readFileSync(join(output,'native/trace.json'),'utf8'));assert.equal(trace.length,native.traceEvents);assert.deepEqual(verifyCursorClosure(trace),native.nativeCursors);
  for(const name of native.nativeQueryPhases)verifyIndexedTrace(trace,name,{maximum:128,success:true});
  const events=JSON.parse(readFileSync(join(output,'native/events.json'),'utf8'));const bsonDir=join(output,'native/bson');report.native=verifyCustodyArtifacts({pairs:native.result.pairs,original,events,trace,files:readdirSync(bsonDir),read:name=>readFileSync(join(bsonDir,name)),deserialize:b=>BSON.deserialize(b,{promoteLongs:false})});

 }catch(error){retainPrimary(error);report.failure=safeFailure(primary);}
 finally{
  if(fixture){try{report.diagnostics=fixture.diagnostics();json(join(output,'before-cleanup.json'),report);}catch(error){retainPrimary(error);report.evidenceFailure=safeFailure(error).message;}
   try{await fixture.cleanup();assert.equal(fixture.cleanupResult.verified,true);}catch(error){retainPrimary(error);report.cleanupFailure=safeFailure(error).message;}}
  try{process.off('SIGINT',stop);process.off('SIGTERM',stop);}catch(error){retainPrimary(error);report.listenerCleanupFailure=safeFailure(error).message;}if(hasPrimary)report.failure??=safeFailure(primary);report.status=hasPrimary?'failed':'passed-bounded-royalty-driver-event-only';try{json(join(output,'controller.json'),report);}catch(error){retainPrimary(error);report.finalEvidenceFailure=safeFailure(error).message;report.failure??=safeFailure(primary);report.status='failed';}
 }if(hasPrimary)throw primary;return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.equal(process.argv.length,8);assert.deepEqual(process.argv.slice(2,4),['--profile',PROFILE]);const report=await runCI(PROFILE,process.argv[4],process.argv[5],process.argv[6],process.argv[7]);console.log(JSON.stringify({status:report.status,profile:PROFILE,run:report.run}));}
