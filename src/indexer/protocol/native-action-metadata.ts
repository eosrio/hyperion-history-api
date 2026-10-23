import type {ProtocolAbiActionInput} from '@eosrio/hyperion-sdk/protocol';
import type {ProtocolAbiProofSource} from './abi-proof.js';
import type {ProtocolNativeObservationReadback} from './native-observation-store.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';
import {protocolSourceContextId, type ProtocolSourceProfile} from './source-bindings.js';

/** Locators only: stored labels and successful parsing never grant native decoding authority. */
export interface ProtocolNativeActionProofMetadata {
    readonly schemaVersion: 2;
    readonly kind: 'native';
    readonly source: ProtocolAbiProofSource;
    readonly selectionId: string;
    readonly input: ProtocolAbiActionInput;
    readonly native: {
        readonly nativeKind: string;
        readonly contextId: string;
        readonly linkId: string;
        readonly observationId: string;
        readonly observationDigest: string;
        readonly captureRef: ProtocolNativeObservationReadback['record']['captureRef'];
        readonly inventorySha256: string;
        readonly profile: ProtocolSourceProfile;
    };
}
export type ProtocolNativeActionIncompleteMetadata = Omit<ProtocolNativeActionProofMetadata, 'kind' | 'native'> & {
    readonly kind: 'incomplete';
    readonly native: Omit<ProtocolNativeActionProofMetadata['native'], 'nativeKind'>;
    readonly status: 'incomplete';
    readonly error: {readonly code: string; readonly message: string};
};
export type ProtocolNativeActionSourceMetadata = ProtocolNativeActionIncompleteMetadata
    | (ProtocolNativeActionProofMetadata & {readonly status: 'incomplete'; readonly error: {readonly code: string; readonly message: string}});
export type ProtocolNativeActionMetadata = ProtocolNativeActionProofMetadata | ProtocolNativeActionSourceMetadata;

const keys = (value: any, fields: string[]) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const hex64 = /^[0-9a-f]{64}$/;
const digest = (value: unknown) => typeof value === 'string' && hex64.test(value);
const id = (prefix: string, value: unknown) => typeof value === 'string' && new RegExp('^' + prefix + ':[0-9a-f]{64}$').test(value);
const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length > 0 && value.length <= maximum && value.isWellFormed();
function valid(value: unknown): asserts value {if (!value) throw new Error('Invalid native action metadata locator');}

/** Strict, detached shape validation. Canonical readers must still reproduce every locator field. */
export function parseProtocolNativeActionMetadata(input: unknown): ProtocolNativeActionMetadata {
    const value = JSON.parse(protocolImmutableJson(input, 64 * 1024 * 1024));
    const incomplete = value?.status === 'incomplete';
    valid(keys(value, ['schemaVersion', 'kind', 'source', 'selectionId', 'input', 'native', ...(incomplete ? ['status', 'error'] : [])])
        && value.schemaVersion === 2 && ['native', 'incomplete'].includes(value.kind)
        && (value.kind !== 'incomplete' || incomplete));
    valid(keys(value.source, ['chainId', 'blockNum', 'blockId']) && digest(value.source.chainId) && digest(value.source.blockId)
        && Number.isSafeInteger(value.source.blockNum) && value.source.blockNum >= 1 && value.source.blockNum <= 0xffffffff
        && id('h45srcsel1', value.selectionId));
    valid(keys(value.input, ['transactionId', 'actionOrdinal', 'inputActionOrdinal', 'receiver', 'account', 'name',
        'rawHex', 'globalSequence', 'receiptAbiSequence']));
    const native = value.native;
    valid(keys(native, ['contextId', 'linkId', 'observationId', 'observationDigest', 'captureRef', 'inventorySha256', 'profile',
        ...(value.kind === 'native' ? ['nativeKind'] : [])])
        && id('h45srcctx1', native.contextId) && id('h45srcnat1', native.linkId) && id('h45natobs1', native.observationId)
        && digest(native.observationDigest) && digest(native.inventorySha256)
        && (value.kind !== 'native' || text(native.nativeKind, 256)));
    valid(keys(native.captureRef, ['abiObservationId', 'abiObservationDigest', 'inputSha256'])
        && id('h45abi1', native.captureRef.abiObservationId) && digest(native.captureRef.abiObservationDigest) && digest(native.captureRef.inputSha256));
    protocolSourceContextId({schemaVersion: 1, chainId: value.source.chainId, protocol: native.profile, schemaJson: '{}'});
    if (incomplete) valid(keys(value.error, ['code', 'message']) && text(value.error.code, 128) && text(value.error.message, 4096));
    return value;
}
