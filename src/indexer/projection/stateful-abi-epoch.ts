import {createHash} from 'node:crypto';
import type {ProtocolAbiAccountState} from '../protocol/abi-reducer.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

/**
 * A normalized reference to an already reader-verified deployment occurrence, never authority.
 * Callers must obtain the state from the issued action/final-state proof and revalidate that proof.
 * Keep the scalar block-end protocolDeployment identity unchanged.
 */
export function statefulAbiEpoch(state: ProtocolAbiAccountState): {readonly id: string; readonly abiSha256: string} {
    if (!state.present || typeof state.abiHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(state.abiHex))
        throw new Error('Stateful input requires a present original ABI');
    const abiSha256 = createHash('sha256').update(Buffer.from(state.abiHex, 'hex')).digest('hex');
    const provenance = {account: state.account, abiSha256, source: state.source};
    // The native-effect anchor/sequence and block-end delta coordinate remain inside source.
    // Identical ABI bytes redeployed within one block therefore cannot reuse an earlier epoch.
    const id = 'h45sepoch2:' + createHash('sha256')
        .update(protocolImmutableJson(['hyperion-stateful-abi-epoch-v2', provenance])).digest('hex');
    return Object.freeze({id, abiSha256});
}
