import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SourceTextModule, SyntheticModule, createContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {isPromise} from 'node:util/types';
import {EventEmitter} from 'node:events';
const context = createContext({});
const source = readFileSync(new URL('../../scripts/qualification/worker-failure-diagnostics.mjs', import.meta.url), 'utf8');
const mod = new SourceTextModule(source, {context});
await mod.link(async spec => {
 const exports = spec === 'node:crypto' ? {randomUUID} : spec === 'node:util/types' ? {isPromise} : {ProofConsumerScope: class {run(){}}};
 return new SyntheticModule(Object.keys(exports), function(){for (const [k,v] of Object.entries(exports)) this.setExport(k,v);}, {context});
});
await mod.evaluate();
const {installWorkerFailureDiagnostics} = mod.namespace;
const cluster = new EventEmitter(); cluster.isPrimary = true;
let nextPid = 20;
cluster.fork = function(env) { const worker = new EventEmitter(); worker.id = nextPid; worker.process = {pid: nextPid++}; return worker; };
class Master {
 handleWorkerDisconnect(worker) {const d=this.workerMap.find(x=>x.wref===worker); if(d){delete d.wref; d.failures=(d.failures??0)+1;} return 17;}
 relaunchDisconnectedWorker() {this.launchWorkers(); return 42;}
 launchWorkers() {for(const d of this.workerMap) if(!d.wref) {const w=cluster.fork(d.worker_role==='reader'?{...d,reader_pressure_sync:'true'}:d); d.wref=w;} if(this.foreignEnv) cluster.fork(this.foreignEnv);}
}
const rows=[]; let failures=0;
installWorkerFailureDiagnostics({Master,cluster, emit:(event,snapshot)=>rows.push({event,...snapshot()}),workerIdentity:w=>({pid:w.process.pid}),failed:()=>failures++});
const first={worker_id:1,worker_role:'projection'}, second={worker_id:2,worker_role:'reader'};
const master=Object.assign(new Master(),{workerMap:[first,second]}); master.launchWorkers();
const originals=[first.wref,second.wref];
for(const w of originals) {cluster.emit('fork',w); cluster.emit('disconnect',w); assert.equal(master.handleWorkerDisconnect(w),17);}
const foreign={worker_id:9,worker_role:'reader'}; master.workerMap.push(foreign);
let accessorCalls=0; master.foreignEnv=Object.defineProperty({},'worker_id',{get(){accessorCalls++; throw Error('foreign accessor');}});
assert.equal(master.relaunchDisconnectedWorker(originals[0],first),42);
const forked=rows.filter(r=>r.event==='worker_replacement_forked');
assert.equal(forked.length,2,'each original replacement has a diagnostic fork');
for(const [i,d] of [first,second].entries()) {const row=forked.find(r=>r.logicalWorkerId===d.worker_id); assert.equal(row.previous.pid,originals[i].process.pid); assert.equal(row.child.pid,d.wref.process.pid);}
assert.ok(!forked.some(r=>r.child.pid===foreign.wref.process.pid)); assert.equal(accessorCalls,0); assert.equal(failures,0);
master.handleWorkerDisconnect(originals[0]); assert.equal(rows.filter(r=>r.event==='worker_replacement_requested').length,2, 'stale physical worker grants no request');
console.log(JSON.stringify({passed:true, controlledVmOnly:true, physicalFaultEvidence:false}));
