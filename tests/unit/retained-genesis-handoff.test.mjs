import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {prepared} from './portable-state-source-fixture.mjs';
const {protocolAbiCaptureDigest}=await import('../../build/indexer/protocol/abi-observation-store.js');
const {preflightRetainedGenesis}=await import('../../build/indexer/protocol/retained-genesis-preflight.js');
const parent=resolve(tmpdir()),temp=mkdtempSync(join(parent,'wire-genesis-handoff-')),fixture=resolve('tests/fixtures/portable-state-worker');
after(()=>{assert.equal(dirname(temp),parent);assert.ok(basename(temp).startsWith('wire-genesis-handoff-'));rmSync(temp,{recursive:true,force:true});});
const run=spawnSync(process.platform==='win32'?'python':'python3',[join(fixture,'prepare.py'),join(temp,'original')],{encoding:'utf8',timeout:30000});assert.equal(run.status,0,run.stderr);
assert.equal(JSON.parse(run.stdout).archiveSha256,'42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
const dir=join(temp,'original','source'),schemaJson=readFileSync(join(dir,'schema.json'),'utf8'),frames=Array.from({length:5},(_,i)=>readFileSync(join(dir,'block-'+String(i+1).padStart(6,'0')+'.bin'))),hash=b=>createHash('sha256').update(b).digest('hex');
const capture={chainId:'9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d',profileId:'wire-sysio-6508c9e8-native-engineering-v1'};

test('original genesis and contiguous source survive explicit revoke and generation-fenced live handoff', {timeout:30000},async()=>{
 const p=await prepared({},4,undefined,{frames,schemaJson,capture});const before=await p.coordinator.inspect();assert.equal(before.head.blockNum,4);assert.equal(before.head.coverageStart,1);
 const genesisId='000000012fdf78889e4c7210b63f56607f294a9b9d90058c053a218103192187',blockTwoId='000000028614067823d55b9058cdf0fa023b2de5b0eb0657c9b0a3b318bbf923';
 const genesis=preflightRetainedGenesis({chainId:capture.chainId,rpcChainId:capture.chainId,rpcGenesisId:genesisId,rpcBlockTwoId:blockTwoId,rpcBlockTwoPreviousId:genesisId,schemaJson,schemaSha256:hash(schemaJson),frame:frames[0],frameSha256:'bdfdb8832cc573cca61f3e53cfa71219241e008b5c9665626295ea9342c2fb60',blockTwoFrame:frames[1],blockTwoFrameSha256:'cad3cd731991f93d5d704cf4a5e0afd457eab7dc3f8bb6f5a1e303058795ed1c'},p.options.provider);
 assert.equal(genesis.authorityGranted,false);assert.equal(await p.coordinator.revokeSource('fixture-source',before.generation),true);
 const opened=await p.coordinator.openSource(p.contextId,'handoff-live-source');assert.notEqual(opened.generation,before.generation);assert.equal(opened.resumeFromBlock,5);
 const ship=p.options.provider.createShipSession(JSON.parse(schemaJson));
 try {
  const decoded=ship.decodeResult(frames[4])[1],source={chainId:capture.chainId,blockNum:decoded.this_block.block_num,blockId:decoded.this_block.block_id,previousBlockId:decoded.prev_block.block_id};assert.equal(source.blockNum,5);assert.equal(source.previousBlockId,before.head.blockId);
  const sections={kind:'unattested-ship-result-sections-v1',schemaJson,blockHex:decoded.block,tracesHex:decoded.traces,deltasHex:decoded.deltas},captureSha256=protocolAbiCaptureDigest(source,sections);
  const selection=await p.bindings.prepareSelection({schemaVersion:1,contextId:p.contextId,readerSessionId:'handoff-live-source',readerRole:'live',assignmentId:null,source,frameSha256:hash(frames[4]),captureSha256,head:{blockNum:decoded.head.block_num,blockId:decoded.head.block_id},irreversible:{blockNum:decoded.last_irreversible.block_num,blockId:decoded.last_irreversible.block_id}});
  const rows=[];let ordinal=0;for(const [,delta] of ship.decodeDeltas(Buffer.from(decoded.deltas,'hex')))for(const row of delta.rows){if(delta.name==='account'){const raw=Buffer.from(row.data,'hex');rows.push({ordinal,present:row.present===1,raw,value:ship.decodeRow('account',raw)});}ordinal++;}
  const observation={status:'observed',facts:p.options.provider.observeBlockAbi({traces:ship.decodeTraces(Buffer.from(decoded.traces,'hex')),accountRows:rows},source)};
  const original=await p.observations.prepare({schemaVersion:1,protocol:p.options.profile,source:{...source,inputSha256:captureSha256},capture:sections,observation});await p.bindings.prepareObservationLink({schemaVersion:1,selectionId:selection.id,observationId:original.id,observationDigest:original.digest});
  assert.equal((await p.coordinator.admit(selection.id,before.generation)).status,'stale');assert.equal((await p.coordinator.admit(selection.id,opened.generation)).status,'accepted');await p.coordinator.drain();const after=await p.coordinator.inspect();assert.equal(after.head.blockNum,5);assert.equal(after.head.coverageStart,1);assert.equal(after.source.readerSessionId,'handoff-live-source');
 } finally {ship.close?.();}
});
