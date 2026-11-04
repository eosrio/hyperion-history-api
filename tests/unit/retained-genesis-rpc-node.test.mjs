import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {APIClient} from '@wharfkit/antelope';
import {verifyRetainedGenesisInput} from '../../build/indexer/protocol/retained-genesis-input.js';
import {prepared,frames,schemaJson,capture,hash} from './portable-state-source-fixture.mjs';

test('real Wire response identity and native genesis preflight reject malformed boundaries',async()=>{
 const p=await prepared({},0),dir=mkdtempSync(join(tmpdir(),'wire-rpc-genesis-'));
 try {
  const config={schema_path:join(dir,'schema'),schema_sha256:hash(schemaJson),frame_path:join(dir,'one'),frame_sha256:hash(frames[0]),block_two_path:join(dir,'two'),block_two_sha256:hash(frames[1])};
  writeFileSync(config.schema_path,schemaJson);writeFileSync(config.frame_path,frames[0]);writeFileSync(config.block_two_path,frames[1]);
  const blocks=[1,2].map(n=>JSON.parse(readFileSync(new URL(`./fixtures/wire-native-genesis/rpc-block${n}-20261104.json`,import.meta.url),'utf8')));
  assert.ok(blocks.every(b=>!Object.hasOwn(b,'confirmed')));
  let current=blocks,lib=2,chain=capture.chainId;
  const api=new APIClient({provider:{async call({path,params}){assert.equal(path,'/v1/chain/get_block');return {status:200,json:current[params.block_num_or_id-1],text:'',headers:{}}}}});
  const rpc={v1:{chain:{async get_info(){return {chain_id:chain,last_irreversible_block_num:lib}}}},call:args=>api.call(args)};
  const verify=()=>verifyRetainedGenesisInput(config,capture.chainId,p.options.provider,rpc);
  assert.equal((await verify()).verified.source.blockId,blocks[0].id);
  for(const change of [{id:'invalid'},{id:blocks[1].id},{block_num:2},{previous:'f'.repeat(64)}]){current=[{...blocks[0],...change},blocks[1]];await assert.rejects(verify)}
  current=[blocks[0],{...blocks[1],previous:'0'.repeat(64)}];await assert.rejects(verify);
  current=[blocks[0],{...blocks[1],id:'00000002'+'f'.repeat(56)}];await assert.rejects(verify);
  current=blocks;lib=1;await assert.rejects(verify);lib=2;chain='f'.repeat(64);await assert.rejects(verify);
 } finally {rmSync(dir,{recursive:true,force:true})}
});
