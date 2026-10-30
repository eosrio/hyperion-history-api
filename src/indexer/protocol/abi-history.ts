import {createHash} from 'node:crypto';
import {protocolImmutableJson} from './immutable-bundle-store.js';
import {protocolSourceContextId, type ProtocolSourceProfile} from './source-bindings.js';
import type {ProtocolAbiHeadCertificate} from './abi-proof.js';

/** Explicit internal historical-source work budget; not a wider recovery/ancestry window. */
export interface ProtocolAbiHistoryOptions {
    readonly interfaceVersion: 1;
    readonly maxCommitsPerDrain: number;
    readonly maxCommitBytesPerDrain: number;
    readonly maxMillisecondsPerDrain: number;
}
export function resolveProtocolAbiHistory(value: ProtocolAbiHistoryOptions | undefined): ProtocolAbiHistoryOptions | undefined {
    if (value === undefined) return undefined;
    if (!value || Object.keys(value).sort().join(',') !== 'interfaceVersion,maxCommitBytesPerDrain,maxCommitsPerDrain,maxMillisecondsPerDrain'
        || value.interfaceVersion !== 1
        || !Number.isSafeInteger(value.maxCommitsPerDrain) || value.maxCommitsPerDrain < 1 || value.maxCommitsPerDrain > 256
        || !Number.isSafeInteger(value.maxCommitBytesPerDrain) || value.maxCommitBytesPerDrain < 1024 || value.maxCommitBytesPerDrain > 128 * 1024 * 1024
        || !Number.isSafeInteger(value.maxMillisecondsPerDrain) || value.maxMillisecondsPerDrain < 1 || value.maxMillisecondsPerDrain > 30_000)
        throw new Error('Invalid explicit historical ABI source budget');
    return Object.freeze({...value});
}
export interface ProtocolAbiHistoricalAddressIdentity {
    readonly schemaVersion: 1;
    readonly chainId: string;
    readonly profile: ProtocolSourceProfile;
    readonly ownerId: string;
    readonly generation: string;
    readonly blockNum: number;
}
export interface ProtocolAbiHistoricalAddress {
    readonly schemaVersion: 1;
    readonly kind: 'historical-abi-certificate-address';
    readonly identity: ProtocolAbiHistoricalAddressIdentity;
    readonly certificateId: string;
}
export interface ProtocolAbiHistoricalRootCertificate {
    readonly schemaVersion: 1;
    readonly kind: 'settled-historical-abi-address-root';
    readonly current: ProtocolAbiHeadCertificate;
    readonly addressRootId: string;
}
/** Selected by the existing settled control CAS, not by the existence of a locator or old certificate. */
export function historicalRootCertificate(current: ProtocolAbiHeadCertificate, addressRootId: string): ProtocolAbiHistoricalRootCertificate {
    if (!/^h45abiroot1:[0-9a-f]{64}$/.test(addressRootId)) throw new Error('Invalid historical ABI address root');
    return {schemaVersion: 1, kind: 'settled-historical-abi-address-root', current, addressRootId};
}
export class ProtocolAbiHistoricalAddressReadError extends Error {
    constructor(readonly code: 'missing' | 'incomplete' | 'invalid', readonly id: string, message: string) {
        super(message); this.name = 'ProtocolAbiHistoricalAddressReadError';
    }
}
export function historicalAddressIdentity(certificate: ProtocolAbiHeadCertificate, blockNum = certificate.head.blockNum): ProtocolAbiHistoricalAddressIdentity {
    const value = {schemaVersion: 1 as const, chainId: certificate.chainId, profile: certificate.profile,
        ownerId: certificate.ownerId, generation: certificate.generation, blockNum};
    historicalAddressId(value); return JSON.parse(protocolImmutableJson(value));
}
/** Predictable exact GET address only. Neither this identity nor its payload grants source coverage. */
export function historicalAddressId(identity: ProtocolAbiHistoricalAddressIdentity): string {
    if (!identity || Object.keys(identity).sort().join(',') !== 'blockNum,chainId,generation,ownerId,profile,schemaVersion'
        || identity.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(identity.chainId)
        || !Number.isSafeInteger(identity.blockNum) || identity.blockNum < 1 || identity.blockNum > 0xffffffff
        || [identity.ownerId, identity.generation].some(value => typeof value !== 'string' || !value.length || value.length > 256 || !value.isWellFormed()))
        throw new Error('Invalid historical ABI address identity');
    protocolSourceContextId({schemaVersion: 1, chainId: identity.chainId, protocol: identity.profile, schemaJson: '{}'});
    return 'h45abihist1:' + createHash('sha256')
        .update(protocolImmutableJson(['hyperion-historical-abi-address-v1', identity], 64 * 1024)).digest('hex');
}
