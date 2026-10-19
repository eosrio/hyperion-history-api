import {createHash} from 'node:crypto';
import type {ProtocolAbiDeployment, ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import {protocolBytes} from './contract-cache.js';

export interface IndexedProtocolAbi {
    account: string;
    block: number;
    block_id: string;
    abi_hex: string;
    protocol_profile: string;
    ordinal?: number;
    valid_until?: number;
    abi_available?: boolean;
    abi_error?: string;
}

/** An indexed ABI reference is provenance, never permission to use a head ABI. */
export function protocolDeployment(provider: ProtocolProvider, reference: IndexedProtocolAbi,
                                   account: string, blockNum: number, blockId: string): ProtocolAbiDeployment {
    if (reference.abi_available === false || !reference.abi_hex || reference.account !== account || reference.protocol_profile !== provider.profileId
        || !Number.isSafeInteger(reference.block) || reference.block < 1 || reference.block > blockNum
        || !/^[0-9a-f]{64}$/.test(reference.block_id)
        || (reference.block === blockNum && reference.block_id !== blockId)
        || (reference.valid_until !== undefined && reference.valid_until <= blockNum)) {
        throw new Error(`Missing compatible ABI deployment for ${account} at ${blockNum}`);
    }
    const bytes = protocolBytes(reference.abi_hex);
    const hash = createHash('sha256').update(bytes).digest('hex');
    return {
        id: `${reference.block_id}:${reference.account}:${hash}`,
        // SHiP account deltas describe the resulting block state. These ABIs are
        // valid for that block's final KV snapshot, not an intra-block action epoch.
        from: {blockNum: reference.block, ordinal: 0},
        ...(reference.valid_until ? {until: {blockNum: reference.valid_until, ordinal: 0}} : {}),
        abi: provider.contractCodec.decodeAbi(bytes),
        abiHex: Buffer.from(bytes).toString('hex'),
    };
}
