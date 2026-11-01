// Stop-capable owned Linux GHA controller. NEVER import/execute on Windows or in offline controls.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createWriteStream,existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {release} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MongoClient,BSON} from 'mongodb';
import {OwnedMongoFixture,MONGODB_IMAGE,MONGODB_VERSION,waitForMongo} from '../projection-fixture.mjs';
import {terminalChild} from '../stateful-complete-kind-mongodb/ci.mjs';
import {afterReadiness} from '../operator-list-mongodb/contract.mjs';
import {PLAN,failure,sha,assertNativeCompletion,persistNativeChildIntent} from './native-contract.mjs';
import {admitNativeAssembly,NATIVE_PROFILE} from './native-assembly.mjs';
import {verifyIndexedTrace,verifyCursorClosure,verifyExplain} from './native-trace.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
export async function runCI(profile,output){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
 assert.equal(realpathSync(process.env.GITHUB_WORKSPACE),realpathSync(root));assert.equal(profile,PLAN.profile);
 output=resolve(output);assert(!relative(root,output).startsWith('..')&&output!==resolve(root));assert(!existsSync(output));mkdirSync(output,{recursive:true});
 const report={schemaVersion:1,status:'running',profile,plan:PLAN,kernel:release(),AtomicSQL:'pending',managedHTTP:'pending',productionOffers:'empty'};
 let fixture,child,original;const stop=()=>{original??=new Error('Indexed native CI controller interrupted');child?.kill('SIGTERM');};const check=()=>{if(original)throw original;};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  check();report.assembly=admitNativeAssembly(profile);
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();const source=process.env.GITHUB_SHA;assert.match(source,/^[a-f0-9]{40}$/);
  report.checkout={commit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),workflowSha:process.env.GITHUB_WORKFLOW_SHA,
   runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,job:process.env.GITHUB_JOB};assert.equal(report.checkout.commit,source);
  assert.equal(git(['status','--porcelain=v1','--untracked-files=all','--','src','packages/backend-mongodb','package.json','package-lock.json','tsconfig.json','.bun-version',
   '.github/workflows/indexed-schema-native.yml',...NATIVE_PROFILE.sourceFiles.map(row=>row.path),'scripts/qualification/indexed-schema-mongodb/native-profile-v1.json']),'','Unreviewed native/fixture source');
  assert.equal(MONGODB_IMAGE,NATIVE_PROFILE.fixture.image);assert.equal(MONGODB_VERSION,PLAN.server);
  // Source/runtime admission and original GHA source binding finish before creating any Docker effect.
  check();fixture=new OwnedMongoFixture();report.run=fixture.run;report.cleanup=fixture.cleanupResult;
  const kernel=fixture.command(['info','--format','{{.KernelVersion}}']);report.dockerKernel=kernel;const version=/^(\d+)\.(\d+)\.(\d+)/.exec(kernel);
  assert(!version||!(Number(version[1])===6&&Number(version[2])>=19||Number(version[1])===7&&Number(version[2])===0&&Number(version[3])<14),'MongoDB8.0.34 kernel constraint');
  check();fixture.prepare();check();const uri=fixture.start('replica');
  const ready=async primary=>{const client=await waitForMongo(()=>{check();return new MongoClient(uri,{directConnection:true,retryReads:false,retryWrites:false,maxAdaptiveRetries:0,maxPoolSize:1,serverSelectionTimeoutMS:1000,connectTimeoutMS:1000});},
   {primary,replicaSet:fixture.replicaSet,timeoutMS:60000});await client.close();check();};
  await afterReadiness(check,()=>ready(false),()=>fixture.initializeReplica());
  report.child=await afterReadiness(check,()=>ready(true),()=>{
   const owned=fixture.ownedContainer('replica'),image=fixture.inspect('image',MONGODB_IMAGE);assert.equal(image.Os,'linux');assert.equal(image.Architecture,'amd64');assert.equal(owned.Image,image.Id);
   assert.equal(owned.HostConfig.NanoCpus,NATIVE_PROFILE.fixture.nanoCPUs);assert.equal(owned.HostConfig.Memory,NATIVE_PROFILE.fixture.memoryBytes);
   report.container={id:owned.Id,name:owned.Name,labels:owned.Config.Labels,imageId:image.Id,repoDigests:image.RepoDigests,replicaSet:fixture.replicaSet,volume:fixture.volume.name,
    cpus:owned.HostConfig.NanoCpus,memory:owned.HostConfig.Memory,memorySwap:owned.HostConfig.MemorySwap,port:owned.NetworkSettings.Ports};
   const runner=fileURLToPath(new URL('./native-runner.mjs',import.meta.url)),argv=[runner,'--profile',profile,'--run','--allow-failpoints','--database','h45_indexed_'+fixture.run.slice(0,12),
    '--output',join(output,'native'),'--source',source,'--assembly-sha256',report.assembly.observationSha256];
   const invocation=persistNativeChildIntent({executable:process.execPath,argv,cwd:root,source,runtime:report.assembly.runtime,
    limits:{query:PLAN.limits,operationMS:PLAN.operationMS,transactionMS:PLAN.transactionMS,fixture:NATIVE_PROFILE.fixture},
    environment:{HYPERION_INDEXED_MONGO_URI:uri+'&replicaSet='+fixture.replicaSet}},intent=>json(join(output,'child-intent.json'),intent));
   report.childInvocation=invocation;check();child=spawn(invocation.executable,invocation.argv,{cwd:invocation.cwd,stdio:['ignore','pipe','pipe'],env:{...process.env,...invocation.environment}});
   if(Number.isSafeInteger(child.pid)&&child.pid>0)report.childProcess={pid:child.pid};
   return terminalChild(child,createWriteStream(join(output,'runner.stdout.log'),{flags:'wx'}),createWriteStream(join(output,'runner.stderr.log'),{flags:'wx'}),
    {deadlineMS:NATIVE_PROFILE.fixture.childDeadlineMS,graceMS:NATIVE_PROFILE.fixture.graceMS,terminalMS:NATIVE_PROFILE.fixture.terminalMS});
  });if(report.childProcess)json(join(output,'child-process.json'),report.childProcess);json(join(output,'child-terminal.json'),report.child);check();
  const native=JSON.parse(readFileSync(join(output,'native/report.json'),'utf8'));assertNativeCompletion(report.child,native,report.assembly.observationSha256);
  const checksums=JSON.parse(readFileSync(join(output,'native/sha256.json'),'utf8'));assert.deepEqual(checksums.map(row=>row.path).sort(),['explain.json','report.json','samples.json','trace.json']);
  for(const row of checksums){const raw=readFileSync(join(output,'native',row.path));assert.equal(raw.length,row.bytes);assert.equal(sha(raw),row.sha256);}
  assert.equal(native.runtime.node,process.version);assert.equal(native.runtime.executableSha256,report.assembly.runtime.executableSha256);
  const trace=JSON.parse(readFileSync(join(output,'native/trace.json'),'utf8'));assert.equal(trace.length,native.traceEvents);assert.deepEqual(verifyCursorClosure(trace),native.cleanup.cursors);
  for(const query of native.successfulQueryAttestations){const [start,end]=query.trace;assert(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>start&&end<=trace.length);
   const evidence=verifyIndexedTrace(trace.slice(start,end),query.phase,{attempts:query.actualDataAttempts,maximum:query.maximum,success:true});assert.equal(evidence.actualDataAttempts,query.actualDataAttempts);
   for(const row of trace.slice(start,end).filter(row=>row.event==='started'&&row.model&&['aggregate','getMore'].includes(row.command))){assert.equal(row.model,query.model);assert.deepEqual(row.expected,query.view);}}
  const explanations=JSON.parse(readFileSync(join(output,'native/explain.json'),'utf8'));assert.equal(explanations.length,3);
  for(const row of explanations){const actual=BSON.EJSON.deserialize(row.actualCommand,{relaxed:false}),explain=BSON.EJSON.deserialize(row.explain,{relaxed:false});assert.equal(sha(BSON.serialize({pipeline:actual.pipeline})),row.pipelineSha256);
   assert.equal(row.status,'verified');assert.deepEqual(row.afterView,row.sealedView);assert.deepEqual(row.expected,{baseHint:actual.hint,aliases:['collection','assets']});
   for(const raw of [row.catalogBefore,row.catalogAfter])verifyExplain(explain,{baseHint:actual.hint,command:actual,aliases:['collection','assets'],catalog:BSON.EJSON.deserialize(raw,{relaxed:false})});}
  report.native={status:native.status,cases:native.cases.length,independentlyVerifiedQueries:native.successfulQueryAttestations.length,independentlyVerifiedExplains:explanations.length,checksums};
 }catch(error){original??=error;report.failure=failure(original);if(error!==original)report.secondaryFailure=failure(error);}
 finally{
  if(fixture){try{report.diagnostics=fixture.diagnostics();json(join(output,'before-cleanup.json'),report);}catch(error){original??=error;report.evidenceFailure=failure(error);}
   try{await fixture.cleanup();assert.equal(fixture.cleanupResult.verified,true);}catch(error){original??=error;report.cleanupFailure=failure(error);}}
  process.off('SIGINT',stop);process.off('SIGTERM',stop);if(original)report.failure??=failure(original);
  report.status=original?'failed':'passed-native-indexed-only';json(join(output,'controller.json'),report);
 }if(original)throw original;return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.deepEqual(process.argv.slice(2,4),['--profile',PLAN.profile]);assert.equal(process.argv.length,5);const report=await runCI(PLAN.profile,process.argv[4]);console.log(JSON.stringify({status:report.status,run:report.run}));}
