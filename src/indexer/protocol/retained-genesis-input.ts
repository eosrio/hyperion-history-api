import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, openSync, readSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import type {MainSettings} from '../../interfaces/hyperionConfig.js';
import type {ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import {preflightRetainedGenesis} from './retained-genesis-preflight.js';

export type RetainedGenesisConfig = NonNullable<NonNullable<MainSettings['protocol_abi_coordination']>['retained_genesis']>;

/** Read one exact bounded file through a single descriptor; no pathname is trusted as an identity. */
function readPinned(path:string, expected:string, limit:number):Buffer {
    if(!isAbsolute(path)||!/^[0-9a-f]{64}$/.test(expected))throw new Error('Invalid retained genesis source pin');
    const fd=openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const before=fstatSync(fd);
        if(!before.isFile()||before.size<1||before.size>limit)throw new Error('Retained genesis source is not a bounded regular file');
        const bytes=Buffer.alloc(before.size);let offset=0;
        while(offset<bytes.length){const read=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!read)throw new Error('Retained genesis source truncated');offset+=read;}
        const after=fstatSync(fd);
        if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs
            ||createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Retained genesis source changed or does not match its pin');
        return bytes;
    } finally {closeSync(fd);}
}

/** This is source custody only; chain identity and the selected provider still require preflight. */
export function loadRetainedGenesisInput(config:RetainedGenesisConfig):{schemaJson:string;frame:Buffer;blockTwoFrame:Buffer} {
    const schema=readPinned(config.schema_path,config.schema_sha256,65536);
    const schemaJson=new TextDecoder('utf-8',{fatal:true}).decode(schema);
    return {schemaJson,frame:readPinned(config.frame_path,config.frame_sha256,4*1024*1024),
        blockTwoFrame:readPinned(config.block_two_path,config.block_two_sha256,4*1024*1024)};
}

/** Master-side verification; the RPC supplies independent chain and irreversible block identity. */
export async function verifyRetainedGenesisInput(config:RetainedGenesisConfig,chainId:string,provider:ProtocolProvider,
    rpc:{v1:{chain:{get_info():Promise<{chain_id:unknown;last_irreversible_block_num:unknown}>}};
        call(args:{path:string;params:unknown}):Promise<unknown>}) {
    const input=loadRetainedGenesisInput(config);
    const before=await rpc.v1.chain.get_info();
    const irreversible=(value:unknown)=>{const n=Number(String(value));return Number.isSafeInteger(n)&&n>=2&&n<=0xffffffff;};
    if(String(before.chain_id).toLowerCase()!==chainId||!irreversible(before.last_irreversible_block_num))
        throw new Error('Retained genesis RPC chain or irreversible boundary differs');
    const readIdentity=async(height:1|2)=>{
        const value=await rpc.call({path:'/v1/chain/get_block',params:{block_num_or_id:height}});
        if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid retained genesis RPC block');
        const block=value as {id?:unknown;previous?:unknown;block_num?:unknown};
        if(typeof block.id!=='string'||typeof block.previous!=='string'||! /^[0-9a-f]{64}$/.test(block.id)
            ||! /^[0-9a-f]{64}$/.test(block.previous)||block.block_num!==height||parseInt(block.id.slice(0,8),16)!==height)
            throw new Error('Invalid retained genesis RPC block identity');
        if(height===1&&block.previous!=='0'.repeat(64))throw new Error('Invalid genesis RPC parent');
        return {id:block.id,previous:block.previous};
    };
    const first=await readIdentity(1), second=await readIdentity(2);
    const after=await rpc.v1.chain.get_info();
    if(String(after.chain_id).toLowerCase()!==chainId||!irreversible(after.last_irreversible_block_num))
        throw new Error('Retained genesis RPC identity changed');
    const verified=preflightRetainedGenesis({chainId,rpcChainId:String(after.chain_id).toLowerCase(),
        rpcGenesisId:String(first.id).toLowerCase(),rpcBlockTwoId:String(second.id).toLowerCase(),
        rpcBlockTwoPreviousId:String(second.previous).toLowerCase(),schemaJson:input.schemaJson,schemaSha256:config.schema_sha256,
        frame:input.frame,frameSha256:config.frame_sha256,blockTwoFrame:input.blockTwoFrame,blockTwoFrameSha256:config.block_two_sha256},provider);
    return {...input,verified};
}
