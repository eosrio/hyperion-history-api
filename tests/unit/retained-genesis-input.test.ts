import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {APIClient} from '@wharfkit/antelope';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadRetainedGenesisInput,verifyRetainedGenesisInput} from '../../src/indexer/protocol/retained-genesis-input.js';
import {prepared,frames,schemaJson,capture,hash} from './portable-state-source-fixture.mjs';

test('retained genesis reads exact bounded source pins and rejects replacement bytes',()=>{
    const dir=mkdtempSync(join(tmpdir(),'retained-source-'));
    try {
        const schema=Buffer.from('{}'),one=Buffer.from([1,2,3]),two=Buffer.from([4,5,6]);
        const pin=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
        const config={schema_path:join(dir,'schema'),schema_sha256:pin(schema),frame_path:join(dir,'one'),frame_sha256:pin(one),
            block_two_path:join(dir,'two'),block_two_sha256:pin(two)};
        writeFileSync(config.schema_path,schema);writeFileSync(config.frame_path,one);writeFileSync(config.block_two_path,two);
        expect(loadRetainedGenesisInput(config)).toEqual({schemaJson:'{}',frame:one,blockTwoFrame:two});
        writeFileSync(config.frame_path,Buffer.from([1,2,4]));
        expect(()=>loadRetainedGenesisInput(config)).toThrow('does not match its pin');
        expect(()=>loadRetainedGenesisInput({...config,schema_path:'relative'})).toThrow('source pin');
    } finally {rmSync(dir,{recursive:true,force:true});}
});

test('master preflight compares pinned native frames against irreversible RPC identities',async()=>{
    const p=await prepared({},0),dir=mkdtempSync(join(tmpdir(),'retained-preflight-'));
    const ship=p.options.provider.createShipSession(JSON.parse(schemaJson));
    try {
        const one=ship.decodeResult(frames[0])[1],two=ship.decodeResult(frames[1])[1];
        const config={schema_path:join(dir,'schema'),schema_sha256:hash(schemaJson),frame_path:join(dir,'one'),frame_sha256:hash(frames[0]),
            block_two_path:join(dir,'two'),block_two_sha256:hash(frames[1])};
        writeFileSync(config.schema_path,schemaJson);writeFileSync(config.frame_path,frames[0]);writeFileSync(config.block_two_path,frames[1]);
        const actual=[1,2].map(n=>JSON.parse(readFileSync(new URL(`./fixtures/wire-native-genesis/rpc-block${n}-20261104.json`,import.meta.url),'utf8')));
        expect(actual.every(value=>!Object.hasOwn(value,'confirmed'))).toBe(true);
        const client=new APIClient({provider:{call:async({path,params}:any)=>{
            if(path!=='/v1/chain/get_block')throw new Error('unexpected route');
            return {status:200,json:actual[params.block_num_or_id-1],text:'',headers:{}};
        }}});
        const rpc={v1:{chain:{get_info:async()=>({chain_id:capture.chainId,last_irreversible_block_num:2})}},
            call:({path,params}:{path:string;params:unknown})=>client.call({path,params})};
        const result=await verifyRetainedGenesisInput(config,capture.chainId,p.options.provider,rpc);
        expect(result.verified.authorityGranted).toBe(false);
        expect(result.verified.source.blockId).toBe(one.this_block.block_id);
        const bad=async (value:unknown,n:number)=>({ ...rpc,call:async({params}:{path:string;params:unknown})=>
            (params as {block_num_or_id:number}).block_num_or_id===n ? value : rpc.call({path:'/v1/chain/get_block',params}) });
        for(const value of [null,{}, {id:'bad',previous:'0'.repeat(64),block_num:1},
            {id:one.this_block.block_id,previous:'f'.repeat(64),block_num:1},
            {id:one.this_block.block_id,previous:'0'.repeat(64),block_num:2}])
            await expect(verifyRetainedGenesisInput(config,capture.chainId,p.options.provider,await bad(value,1))).rejects.toThrow();
        await expect(verifyRetainedGenesisInput(config,capture.chainId,p.options.provider,await bad({id:two.this_block.block_id,previous:'0'.repeat(64),block_num:2},2))).rejects.toThrow();
        await expect(verifyRetainedGenesisInput(config,'f'.repeat(64),p.options.provider,rpc)).rejects.toThrow('chain or irreversible');
        await expect(verifyRetainedGenesisInput(config,capture.chainId,p.options.provider,{v1:{chain:{...rpc.v1.chain,
            get_info:async()=>({chain_id:capture.chainId,last_irreversible_block_num:'bad'})}},call:rpc.call})).rejects.toThrow('irreversible');
    } finally {ship.close?.();rmSync(dir,{recursive:true,force:true});}
});
