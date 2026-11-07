import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
const {preflightRetainedGenesis}=await import('../../build/indexer/protocol/retained-genesis-preflight.js');
const {loadChainProtocol}=await import('../../build/indexer/protocol/selection.js');
const fixture=resolve('tests/fixtures/portable-state-worker'), parent=resolve(tmpdir()), temp=mkdtempSync(join(parent,'wire-genesis-preflight-'));
after(()=>{assert.equal(dirname(temp),parent);assert.ok(basename(temp).startsWith('wire-genesis-preflight-'));rmSync(temp,{recursive:true,force:true});});
const run=spawnSync(process.platform==='win32'?'python':'python3',[join(fixture,'prepare.py'),join(temp,'original')],{encoding:'utf8',timeout:30000});assert.equal(run.status,0,run.stderr);
const evidence=JSON.parse(run.stdout);assert.equal(evidence.archiveSha256,'42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
const root=join(temp,'original','source'),frame=readFileSync(join(root,'block-000001.bin')),blockTwoFrame=readFileSync(join(root,'block-000002.bin')),schemaJson=readFileSync(join(root,'schema.json'),'utf8');
const sha=b=>createHash('sha256').update(b).digest('hex');
const original={chainId:'9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d',rpcChainId:'9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d',rpcGenesisId:'000000012fdf78889e4c7210b63f56607f294a9b9d90058c053a218103192187',rpcBlockTwoId:'000000028614067823d55b9058cdf0fa023b2de5b0eb0657c9b0a3b318bbf923',rpcBlockTwoPreviousId:'000000012fdf78889e4c7210b63f56607f294a9b9d90058c053a218103192187',schemaJson,schemaSha256:sha(schemaJson),frame,blockTwoFrame,blockTwoFrameSha256:'cad3cd731991f93d5d704cf4a5e0afd457eab7dc3f8bb6f5a1e303058795ed1c',frameSha256:'bdfdb8832cc573cca61f3e53cfa71219241e008b5c9665626295ea9342c2fb60'};
const selected=await loadChainProtocol({provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:'wire-sysio-6508c9e8-native-engineering-v1'});
test('pinned original genesis preflight verifies actual provider without granting authority',()=>{
 const result=preflightRetainedGenesis(original,selected.provider);assert.equal(result.source.blockNum,1);assert.equal(result.source.blockId,original.rpcGenesisId);assert.equal(result.blockTwoId,original.rpcBlockTwoId);assert.equal(result.facts.applicationState,'empty');assert.equal(result.authorityGranted,false);
});
test('wrong chain, link, schema, frame or genesis identity fails closed',()=>{
 for(const [key,value] of [['rpcChainId','f'.repeat(64)],['rpcBlockTwoPreviousId','f'.repeat(64)],['rpcGenesisId','f'.repeat(64)],['rpcBlockTwoId','f'.repeat(64)],['blockTwoFrameSha256','f'.repeat(64)],['schemaSha256','f'.repeat(64)],['frameSha256','f'.repeat(64)]])
  assert.throws(()=>preflightRetainedGenesis({...original,[key]:value},selected.provider));
 const changed=Buffer.from(frame);changed[changed.length-1]^=1;
 assert.throws(()=>preflightRetainedGenesis({...original,frame:changed},selected.provider));
});
test('empty traces are not silently substituted for original absence',()=>{
 const provider={...selected.provider,createShipSession(schema){const session=selected.provider.createShipSession(schema);return {...session,decodeResult(bytes){const decoded=session.decodeResult(bytes);decoded[1].traces=Buffer.alloc(0);return decoded;}};}};
 assert.throws(()=>preflightRetainedGenesis(original,provider),/sections differ/);
});

test('genesis input accessors are refused before invocation',()=>{
 let calls=0;const input={...original};Object.defineProperty(input,'chainId',{enumerable:true,get(){calls++;return original.chainId;}});
 assert.throws(()=>preflightRetainedGenesis(input,selected.provider),/inert genesis fields/);assert.equal(calls,0);
});
