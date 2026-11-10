import {createHash} from 'node:crypto';
import type {ProtocolAbiAccountRowInput, ProtocolAbiActionInput, ProtocolNativeActions, ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import type {ProtocolAbiObservationRecord} from './abi-observation-store.js';
import {assertProtocolAbiObservationFacts} from './abi-observation-facts.js';
import {snapshotNativeGenesisFacts} from './native-genesis.js';
import {protocolNativeObservationBounds, type ProtocolNativeObservationRecord} from './native-observation-store.js';
import {protocolNativeInputInventory, snapshotProtocolNativeDecisions} from './native-observation-facts.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';
import type {ProtocolSourcePosition, ProtocolSourceProfile} from './source-bindings.js';
import {deriveProtocolActionInputs} from '../history/action-source-inventory.js';
import {protocolBytes} from './contract-cache.js';

/** Decodes one SHiP section or row under the source's handshake. Codec failures may throw any value. */
export type ProtocolSourceDecode = (type: 'transaction_trace[]' | 'table_delta[]' | 'account', bytes: Uint8Array) => any;
export type ProtocolSourceCapture = ProtocolAbiObservationRecord['capture'];

export interface ProtocolAbiSourceObservation {
    readonly observation: ProtocolAbiObservationRecord['observation'];
    /** Values decoded while observing, reused by the indexer's history path. */
    readonly decoded: {traces?: any; deltas?: any[]; wireActionInputs?: readonly ProtocolAbiActionInput[]};
    /** The first failure, for a caller that must treat codec failures differently from provider ones. */
    readonly failure?: unknown;
}

const hex = (value: string | null) => value === null ? undefined : Buffer.from(value, 'hex');

/** The ABI observation the indexer stores for one source: the provider's facts over its exact
 * sections, or explicit incomplete evidence. Pure: identical inputs give identical records. */
export function observeProtocolAbiSource(provider: ProtocolProvider, decode: ProtocolSourceDecode,
    position: ProtocolSourcePosition, capture: ProtocolSourceCapture, extension: boolean): ProtocolAbiSourceObservation {
    const decoded: {traces?: any; deltas?: any[]; wireActionInputs?: readonly ProtocolAbiActionInput[]} = {};
    try {
        const traces = hex(capture.tracesHex), deltas = hex(capture.deltasHex);
        if (traces?.length) decoded.traces = decode('transaction_trace[]', traces);
        if (deltas?.length) decoded.deltas = decode('table_delta[]', deltas);
        let accountRows: ProtocolAbiAccountRowInput[] | undefined;
        if (decoded.deltas !== undefined) {
            accountRows = [];
            let ordinal = 0;
            for (const delta of decoded.deltas) {
                if (!Array.isArray(delta) || !['table_delta_v0', 'table_delta_v1'].includes(delta[0])
                    || !Array.isArray(delta[1]?.rows)) throw new Error('Unsupported ABI observation delta framing');
                for (const row of delta[1].rows) {
                    if (delta[1].name === 'account') {
                        if (![true, false, 0, 1].includes(row.present)) throw new Error('Invalid ABI account presence');
                        const raw = protocolBytes(row.data);
                        accountRows.push({ordinal, present: row.present === true || row.present === 1,
                            raw, value: decode('account', raw)});
                    }
                    ordinal++;
                }
            }
        }
        if (position.blockNum === 1 && capture.tracesHex === null) {
            if (!provider.verifyNativeGenesis || capture.schemaJson === null || !capture.blockHex || !capture.deltasHex) {
                throw new Error('Native genesis requires a selected verifier and original header/state sections');
            }
            const facts = snapshotNativeGenesisFacts(provider.verifyNativeGenesis({schemaJson: capture.schemaJson,
                block: Buffer.from(capture.blockHex, 'hex'), traces: null, deltas: Buffer.from(capture.deltasHex, 'hex')}, position));
            return {observation: {status: 'native-genesis', facts}, decoded};
        }
        if (typeof provider.observeBlockAbi !== 'function') throw new Error('Selected provider has no ABI observation hook');
        const facts = provider.observeBlockAbi({traces: decoded.traces, accountRows}, position);
        assertProtocolAbiObservationFacts(facts);
        if (extension) decoded.wireActionInputs = facts.actionInputs;
        // Validate malformed provider output here so raw source survives as an incomplete record.
        return {observation: {status: 'observed', facts}, decoded};
    } catch (error: any) {
        return {observation: {status: 'incomplete', error: {code: 'protocol_abi_observation_incomplete',
            message: String(error?.message ?? error).slice(0, 4096).toWellFormed()}}, decoded, failure: error};
    }
}

export interface ProtocolNativeSourceInput {
    readonly contextId: string;
    readonly protocol: ProtocolSourceProfile;
    /** The context's handshake; it must be the one the ABI observation captured. */
    readonly schemaJson: string;
    readonly abi: ProtocolAbiObservationRecord;
    readonly abiObservationId: string;
    readonly abiObservationDigest: string;
}

/** The native observation the indexer stores for one source: decisions over its retained block
 * and traces, or explicit incomplete evidence with a deterministic code. */
export function observeProtocolNativeSource(native: ProtocolNativeActions, decode: ProtocolSourceDecode,
    input: ProtocolNativeSourceInput): ProtocolNativeObservationRecord {
    const {inputSha256, ...position} = input.abi.source;
    const record: ProtocolNativeObservationRecord = {schemaVersion: 1, kind: 'observation', nativeInterfaceVersion: 1,
        contextId: input.contextId, protocol: input.protocol, source: position,
        captureRef: {abiObservationId: input.abiObservationId, abiObservationDigest: input.abiObservationDigest, inputSha256}, inventory: null,
        observation: {status: 'incomplete', error: {code: 'protocol_native_observation_incomplete', message: 'Native extraction unavailable'}}};
    let code = 'protocol_native_observation_incomplete';
    try {
        const capture = input.abi.capture;
        if (!capture.tracesHex) {code = 'native_source_traces_absent'; throw new Error('Original native source traces are absent');}
        if (!capture.blockHex) {code = 'native_source_block_absent'; throw new Error('Original native source block is absent');}
        if (capture.schemaJson !== input.schemaJson) throw new Error('Native source handshake differs from its retained context');
        // Re-decode retained bytes independently: the ABI hook may fail or mutate its own decoded arguments.
        const inputs = deriveProtocolActionInputs(decode('transaction_trace[]', Buffer.from(capture.tracesHex, 'hex')));
        record.inventory = protocolNativeInputInventory(inputs);
        const block = Buffer.from(capture.blockHex, 'hex'), traces = Buffer.from(capture.tracesHex, 'hex');
        const blockDigest = createHash('sha256').update(block).digest('hex'), traceDigest = createHash('sha256').update(traces).digest('hex');
        const facts = native.observe(Object.freeze({schemaJson: capture.schemaJson, block, traces}), Object.freeze({...position}));
        if (createHash('sha256').update(block).digest('hex') !== blockDigest
            || createHash('sha256').update(traces).digest('hex') !== traceDigest) throw new Error('Native observer mutated its source bytes');
        record.observation = {status: 'observed', facts: snapshotProtocolNativeDecisions(facts, inputs)};
        // Deterministic extraction/budget errors become small explicit evidence;
        // storage/configuration/reference errors must escape to the caller.
        protocolImmutableJson(record, protocolNativeObservationBounds.maximumBytes);
    } catch (error: unknown) {
        // Hooks can throw any JavaScript value. Error retention must not
        // invoke accessors or coercion hooks and fail before PREPARE itself.
        let message = code;
        if (typeof error === 'string') message = error;
        else if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
            try {
                const property = Object.getOwnPropertyDescriptor(error, 'message');
                if (property && Object.hasOwn(property, 'value') && typeof property.value === 'string') message = property.value;
            } catch { /* An opaque or revoked proxy still produces incomplete evidence. */ }
        }
        record.observation = {status: 'incomplete', error: {code, message: message.slice(0, 4096).toWellFormed() || code}};
    }
    return record;
}
