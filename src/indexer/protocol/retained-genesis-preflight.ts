import {createHash} from 'node:crypto';
import type {ProtocolBlockAbiSource, ProtocolNativeGenesisFacts, ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import {protocolBytes, protocolNumber} from './contract-cache.js';

/** Inert original-genesis preflight only. This grants no coordinator/source authority. */
export interface RetainedGenesisInput {
    readonly chainId: string;
    readonly rpcChainId: string;
    readonly rpcGenesisId: string;
    readonly rpcBlockTwoId: string;
    readonly rpcBlockTwoPreviousId: string;
    readonly schemaJson: string;
    readonly schemaSha256: string;
    readonly frame: Uint8Array;
    readonly frameSha256: string;
    readonly blockTwoFrame: Uint8Array;
    readonly blockTwoFrameSha256: string;
}
export interface RetainedGenesisPreflight {
    readonly source: ProtocolBlockAbiSource;
    readonly schemaSha256: string;
    readonly frameSha256: string;
    readonly blockTwoId: string;
    readonly facts: ProtocolNativeGenesisFacts;
    readonly authorityGranted: false;
}
const hex64 = /^[0-9a-f]{64}$/;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Verify captured bytes and independent chain/link identities before any source-store effects. */
export function preflightRetainedGenesis(input: RetainedGenesisInput, provider: ProtocolProvider): RetainedGenesisPreflight {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) throw new Error('Inert genesis input required');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const expected = ['blockTwoFrame','blockTwoFrameSha256','chainId','frame','frameSha256','rpcBlockTwoId','rpcBlockTwoPreviousId','rpcChainId','rpcGenesisId','schemaJson','schemaSha256'];
    if (Object.keys(descriptors).sort().join(',') !== expected.join(',') || Object.values(descriptors).some(value => !Object.hasOwn(value,'value') || !value.enumerable)) throw new Error('Exact inert genesis fields required');
    if (!provider || typeof provider.verifyNativeGenesis !== 'function') throw new Error('Native genesis verifier is unavailable');
    const {chainId, rpcChainId, rpcGenesisId, rpcBlockTwoId, rpcBlockTwoPreviousId, schemaJson, schemaSha256, frameSha256, blockTwoFrameSha256} = input;
    if (![chainId,rpcChainId,rpcGenesisId,rpcBlockTwoId,rpcBlockTwoPreviousId,schemaSha256,frameSha256,blockTwoFrameSha256].every(value => typeof value === 'string' && hex64.test(value))
        || chainId !== rpcChainId || rpcGenesisId !== rpcBlockTwoPreviousId
        || typeof schemaJson !== 'string' || Buffer.byteLength(schemaJson) > 65536 || hash(schemaJson) !== schemaSha256
        || !(input.frame instanceof Uint8Array) || input.frame.byteLength === 0 || input.frame.byteLength > 4 * 1024 * 1024
        || !(input.blockTwoFrame instanceof Uint8Array) || input.blockTwoFrame.byteLength === 0 || input.blockTwoFrame.byteLength > 4 * 1024 * 1024) {
        throw new Error('Retained genesis identity or bounds differ');
    }
    const frame = Buffer.from(input.frame);
    if (hash(frame) !== frameSha256) throw new Error('Retained genesis frame differs');
    const blockTwoFrame = Buffer.from(input.blockTwoFrame);
    if (hash(blockTwoFrame) !== blockTwoFrameSha256) throw new Error('Retained block-two frame differs');
    const ship = provider.createShipSession(JSON.parse(schemaJson));
    try {
        const envelope: any = ship.decodeResult(frame);
        if (!Array.isArray(envelope) || envelope[0] !== 'get_blocks_result_v0' || !envelope[1]) throw new Error('Invalid retained genesis envelope');
        const result = envelope[1];
        const source: ProtocolBlockAbiSource = {chainId,blockNum:protocolNumber(result.this_block?.block_num),
            blockId:result.this_block?.block_id?.toString().toLowerCase(),previousBlockId:result.prev_block?.block_id?.toString().toLowerCase() ?? null};
        if (source.blockNum !== 1 || source.blockId !== rpcGenesisId || source.previousBlockId !== null
            || result.traces !== null || result.block == null || result.deltas == null) throw new Error('Retained genesis source or sections differ');
        const next: any = ship.decodeResult(blockTwoFrame);
        if (!Array.isArray(next) || next[0] !== 'get_blocks_result_v0' || protocolNumber(next[1]?.this_block?.block_num) !== 2
            || next[1]?.this_block?.block_id?.toString().toLowerCase() !== rpcBlockTwoId
            || next[1]?.prev_block?.block_id?.toString().toLowerCase() !== rpcGenesisId) throw new Error('Retained block-two source differs');
        const facts = provider.verifyNativeGenesis({schemaJson,block:Buffer.from(protocolBytes(result.block)),traces:null,
            deltas:Buffer.from(protocolBytes(result.deltas))},source);
        return {source,schemaSha256,frameSha256,blockTwoId:rpcBlockTwoId,facts,authorityGranted:false};
    } finally {ship.close?.();}
}
