import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runChild} from './node-test-dispatch.mjs';
function fake(action) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills=[];
  child.kill = signal => {child.kills.push(signal); action?.(child, signal); return true;};
  child.end = (code=0, signal=null) => {child.stdout.end(); child.stderr.end(); setImmediate(()=>child.emit('close',code,signal));};
  return child;
}
const run = (child, opts={}) => runChild('node', [], {spawnProcess:()=>child, deadline:50, grace:20, ...opts});
test('normal success and nonzero rejection', async()=>{
  let c=fake(); let p=run(c); c.end(); await p;
  c=fake(); p=run(c); c.end(2); await assert.rejects(p,/Node fixture failed/);
});
test('spawn failure rejects after close',async()=>{const c=fake(); const p=run(c); c.emit('error',new Error('ENOENT')); c.end(null); await assert.rejects(p,/spawn error/);});
test('deadline cannot pass on exit zero',async()=>{const c=fake((c,s)=>{if(s==='SIGTERM') c.end();}); await assert.rejects(run(c),/deadline exceeded/);});
test('forced termination and bounded missing terminal',async()=>{const c=fake(); await assert.rejects(run(c),/deadline exceeded/); assert.deepEqual(c.kills.slice(0,2),['SIGTERM','SIGKILL']);});
test('parent abort terminates',async()=>{const a=new AbortController();const c=fake((c,s)=>{if(s==='SIGTERM') c.end();});const p=run(c,{signal:a.signal});a.abort();await assert.rejects(p,/aborted/);assert.equal(c.kills[0],'SIGTERM');});
test('overflow and broken streams fail',async()=>{let c=fake((c,s)=>{if(s==='SIGTERM') c.end();});let p=run(c,{cap:2});c.stdout.write('123');await assert.rejects(p,/overflow/);
 c=fake((c,s)=>{if(s==='SIGTERM') c.end();});p=run(c);c.stdout.destroy(new Error('broken'));await assert.rejects(p,/stream error/);
 c=fake();p=run(c);c.emit('close',0,null);await assert.rejects(p,/incomplete/);c.stdout.destroy();c.stderr.destroy();});
