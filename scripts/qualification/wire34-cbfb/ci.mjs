// New-cohort CI only. No service/host dispatch; one owned Node process with original fixture limits.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,writeSync,fsyncSync,lstatSync,readdirSync,copyFileSync,statfsSync,realpathSync,constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {cpus} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {runChild} from './ci-child.mjs';
import {STATEFUL_WIRE34_CBFB_SOURCE_PROFILE,assertWire34Runtime} from './contract.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),output=join(root,'out/wire34-linux'),sha=b=>createHash('sha256').update(b).digest('hex');
export const CI_LIMITS=Object.freeze({deadlineMS:225000,graceMS:2000,streamBytes:1048576,cpuBytes:67108864,maximumCPUs:8,maximumMemoryBytes:34359738368,minimumBeforeAvailableBytes:2147483648,minimumAfterAvailableBytes:1073741824,minimumDiskBytes:4294967296});
export function assertCIResources(value,phase){assert(['before','after'].includes(phase));assert(value.cpus>=2&&value.cpus<=CI_LIMITS.maximumCPUs);assert(value.memoryTotalBytes>0&&value.memoryTotalBytes<=CI_LIMITS.maximumMemoryBytes);assert(value.memoryAvailableBytes>=(phase==='before'?CI_LIMITS.minimumBeforeAvailableBytes:CI_LIMITS.minimumAfterAvailableBytes));assert(value.diskAvailableBytes>=CI_LIMITS.minimumDiskBytes);}
function resourceSnapshot(){const raw=readFileSync('/proc/meminfo','utf8'),field=name=>{const match=raw.match(new RegExp('^'+name+':\\s+(\\d+) kB$','m'));assert(match);return Number(match[1])*1024;},disk=statfsSync(root);return {cpus:cpus().length,memoryTotalBytes:field('MemTotal'),memoryAvailableBytes:field('MemAvailable'),diskAvailableBytes:Number(disk.bavail)*Number(disk.bsize),node:process.version,platform:process.platform,arch:process.arch,pid:process.pid};}
function writeJSON(path,value){
 const fd=openSync(path,'wx');let failed=false,primary;
 try{const b=Buffer.from(JSON.stringify(value,null,2)+'\n');assert.equal(writeSync(fd,b),b.length);fsyncSync(fd);}catch(error){failed=true;primary=error;}
 try{closeSync(fd);}catch(error){if(!failed){failed=true;primary=error;}else try{console.error('Receipt close also failed after the primary write failure');}catch{}}
 if(failed)throw primary;
}
function runtime(){assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_OS,'Linux');assert.equal(process.env.HYPERION_NATIVE_SOURCE_PROFILE,STATEFUL_WIRE34_CBFB_SOURCE_PROFILE);const value={node:process.version,platform:process.platform,arch:process.arch,executable:process.execPath,sha256:sha(readFileSync(process.execPath))};assertWire34Runtime(value);return value;}
export function phaseArguments(phase,cpu){assert(['retained','history','isolated','cpu'].includes(phase));return [...(phase==='cpu'?['--cpu-prof','--cpu-prof-dir='+cpu]:[]),'--test',...(phase==='isolated'?[]:['--test-isolation=none']),phase==='history'?'tests/unit/protocol-abi-history-native.mjs':'tests/unit/wire-managed-state-v2-native.mjs'];}
async function runPhase(phase){const cpu=join(output,'cpu-original');if(phase==='cpu')mkdirSync(cpu,{recursive:false});const args=phaseArguments(phase,cpu),ledger={schemaVersion:1,qualificationOnly:true,phase,command:process.execPath,args,runtime:runtime(),deadlineMS:CI_LIMITS.deadlineMS,innerRetainedDeadlineMS:180000,closed:false,stdoutEOF:false,stderrEOF:false,streams:{stdout:{retained:0,discarded:0},stderr:{retained:0,discarded:0}}};
 writeJSON(join(output,phase+'.intent.json'),{...ledger,status:'before-spawn'});
 const fds={};try{for(const name of ['stdout','stderr'])fds[name]=openSync(join(output,phase+'.'+name),'wx');}catch(error){for(const fd of Object.values(fds))try{closeSync(fd);}catch{}throw error;}
 const controller=new AbortController();let primary,recordFailure;
 const abort=()=>controller.abort();process.once('SIGTERM',abort);process.once('SIGINT',abort);
 try{await runChild(process.execPath,args,{signal:controller.signal,deadline:CI_LIMITS.deadlineMS,grace:CI_LIMITS.graceMS,cap:CI_LIMITS.streamBytes,spawnProcess:(command,argv,options)=>{
  const child=spawn(command,argv,{...options,cwd:root});ledger.pid=child.pid??null;child.once('spawn',()=>{ledger.spawnObserved=true;});child.once('close',(code,signal)=>{ledger.closed=true;ledger.code=code;ledger.signal=signal;});
  for(const name of ['stdout','stderr']){const stream=child[name];if(!stream)continue;stream.once('end',()=>{ledger[name+'EOF']=true;});stream.on('data',chunk=>{try{const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk),row=ledger.streams[name],keep=Math.min(b.length,CI_LIMITS.streamBytes-row.retained);if(keep){const written=writeSync(fds[name],b,0,keep);row.retained+=written;assert.equal(written,keep);}row.discarded+=b.length-keep;}catch(error){recordFailure??=error;controller.abort();}});}
  try{writeJSON(join(output,phase+'.spawn.json'),{pid:ledger.pid,runtime:ledger.runtime,args});}catch(error){recordFailure??=error;queueMicrotask(()=>controller.abort());}
  return child;
 }});ledger.status='passed';}
 catch(error){primary=recordFailure??error;ledger.status='failed';ledger.error=String(primary?.message??primary).slice(0,4096);}
 finally{process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);ledger.streamFilesClosed=0;for(const fd of Object.values(fds)){try{fsyncSync(fd);}catch(error){primary??=error;ledger.status='failed';ledger.fsyncError=String(error).slice(0,512);}try{closeSync(fd);ledger.streamFilesClosed++;}catch(error){primary??=error;ledger.status='failed';ledger.closeError=String(error).slice(0,512);}}
  if(phase==='cpu')try{const names=readdirSync(cpu);assert(names.length===1&&/^CPU\.[A-Za-z0-9_.-]+\.cpuprofile$/.test(names[0]));const original=join(cpu,names[0]),stat=lstatSync(original);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=CI_LIMITS.cpuBytes,'CPU artifact byte bound');const raw=readFileSync(original);assert.equal(raw.length,stat.size);mkdirSync(join(output,'cpu-export'));const exported=join(output,'cpu-export',names[0]);copyFileSync(original,exported,constants.COPYFILE_EXCL);assert.equal(sha(readFileSync(exported)),sha(raw));ledger.cpuArtifact={name:names[0],bytes:raw.length,sha256:sha(raw)};}catch(error){primary??=error;ledger.status='failed';ledger.cpuArtifactError=String(error).slice(0,512);}
  try{writeJSON(join(output,phase+'.json'),ledger);}catch(error){primary??=error;console.error('Phase receipt write failed: '+String(error).slice(0,512));}
 }
 if(primary)throw primary;
}

export function assertIsolatedReceipt(receipt,expectedRuntime){
 assert(receipt&&receipt.schemaVersion===1&&receipt.phase==='isolated'&&receipt.qualificationOnly===true);if(expectedRuntime){assert.equal(receipt.command,expectedRuntime.executable);assert.deepEqual(receipt.runtime,expectedRuntime);}
 assert(['passed','failed'].includes(receipt.status)&&receipt.spawnObserved===true&&Number.isSafeInteger(receipt.pid)&&receipt.pid>0);
 assert(receipt.closed===true&&receipt.stdoutEOF===true&&receipt.stderrEOF===true&&receipt.streamFilesClosed===2);
 assert(receipt.signal===null&&Number.isInteger(receipt.code)&&receipt.code>=0);
 assert((receipt.status==='passed'&&receipt.code===0)||(receipt.status==='failed'&&receipt.code>0&&typeof receipt.error==='string'&&receipt.error.startsWith('Node fixture failed\n')));
 assert(!receipt.fsyncError&&!receipt.closeError&&receipt.streams?.stdout?.discarded===0&&receipt.streams?.stderr?.discarded===0);
 assert.deepEqual(receipt.args,phaseArguments('isolated','unused'));assert.equal(receipt.deadlineMS,CI_LIMITS.deadlineMS);assert.equal(receipt.innerRetainedDeadlineMS,180000);
}
async function main(){const currentRuntime=runtime();const phase=process.argv[2];assert(['before','after','receipts','retained','history','isolated','cpu'].includes(phase));assert.equal(realpathSync(root),realpathSync(process.env.GITHUB_WORKSPACE),'Actual GitHub workspace required');
 const parent=join(root,'out');if(phase==='before')mkdirSync(parent,{recursive:true});assert(lstatSync(parent).isDirectory()&&!lstatSync(parent).isSymbolicLink());if(phase==='before')mkdirSync(output,{recursive:false});assert(lstatSync(output).isDirectory()&&!lstatSync(output).isSymbolicLink());assert.equal(realpathSync(output),join(realpathSync(parent),'wire34-linux'));
 if(phase==='before'||phase==='after'){const value=resourceSnapshot();let failure;try{assertCIResources(value,phase);}catch(error){failure=String(error.message);}writeJSON(join(output,'resources-'+phase+'.json'),{...value,phase,limits:CI_LIMITS,status:failure?'failed':'passed',failure:failure??null});if(failure)throw new Error(failure);return;}
 if(phase==='receipts'){const aliases=[],exact=process.versions.node,major=exact.split('.')[0];for(const kind of ['git','source']){const original=join(output,kind+'.json'),raw=readFileSync(original);assert(lstatSync(original).isFile()&&!lstatSync(original).isSymbolicLink());for(const suffix of [exact,major+'.x']){const alias=join(root,'current-native-'+kind+'-'+suffix+'.json');copyFileSync(original,alias,constants.COPYFILE_EXCL);assert.equal(sha(readFileSync(alias)),sha(raw));aliases.push({path:alias,bytes:raw.length,sha256:sha(raw)});}}writeJSON(join(output,'receipt-aliases.json'),{schemaVersion:1,aliases});return;}
 const preceding=phase==='cpu'?['retained','history',...(process.versions.node.startsWith('26.')?['isolated']:[])]:phase==='isolated'?['retained','history']:phase==='history'?['retained']:[];
 for(const priorPhase of preceding){const prior=JSON.parse(readFileSync(join(output,priorPhase+'.json')));assert(prior.closed===true&&prior.stdoutEOF===true&&prior.stderrEOF===true,'Prior owned '+priorPhase+' process/streams must be closed before next workload');if(priorPhase==='isolated')assertIsolatedReceipt(prior,currentRuntime);}
 if(phase==='isolated'){
  assert(process.versions.node.startsWith('26.'),'Isolated comparison is Node 26 only');
  let failure;try{await runPhase(phase);}catch(error){failure=error;}
  const receipt=JSON.parse(readFileSync(join(output,'isolated.json')));assertIsolatedReceipt(receipt,currentRuntime);
  if(failure&&(receipt.status!=='failed'||!String(failure?.message??failure).startsWith('Node fixture failed\n')))throw failure;
  assert.equal(receipt.status,failure?'failed':'passed','Receipt must match actual phase outcome');
 }else await runPhase(phase);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(String(error?.stack??error).slice(0,8192));process.exitCode=1;});
