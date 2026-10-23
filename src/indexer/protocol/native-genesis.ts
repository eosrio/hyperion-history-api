import type {ProtocolNativeGenesisFacts, ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import {protocolAbiObservationJson, type ProtocolAbiObservationRecord} from './abi-observation-store.js';
import {isProtocolHex} from './hex.js';

export type ProtocolNativeGenesisVerifier = NonNullable<ProtocolProvider['verifyNativeGenesis']>;
export interface ProtocolNativeGenesisCoverage {
    readonly previousBlockId: string;
    readonly applicationState: 'empty';
}
export const zeroBlockId = '0'.repeat(64);

/** Validate/snapshot inert provider output; only the selected verifier establishes source semantics. */
export function snapshotNativeGenesisFacts(input: unknown): ProtocolNativeGenesisFacts {
    protocolAbiObservationJson(input, 64 * 1024 * 1024); // Reject accessors before reading fields.
    const facts = input as ProtocolNativeGenesisFacts;
    if (!facts || facts.schemaVersion !== 1 || facts.previousBlockId !== zeroBlockId || facts.applicationState !== 'empty'
        || !Array.isArray(facts.abiStates) || !facts.abiStates.length || facts.abiStates.length > 100_000
        || Object.keys(facts).some(key => !['schemaVersion', 'previousBlockId', 'applicationState', 'abiStates'].includes(key))) {
        throw new Error('Invalid native genesis facts');
    }
    const accounts = new Set<string>(), ordinals = new Set<number>();
    const abiStates = facts.abiStates.map(state => {
        if (!state || typeof state.account !== 'string' || !state.account.length || state.account.length > 256
            || !state.account.isWellFormed() || state.present !== true || !isProtocolHex(state.abiHex)
            || !Number.isSafeInteger(state.deltaOrdinal) || state.deltaOrdinal < 0 || state.deltaOrdinal > 0xffffffff
            || accounts.has(state.account) || ordinals.has(state.deltaOrdinal)
            || Object.keys(state).some(key => !['account', 'present', 'abiHex', 'deltaOrdinal'].includes(key))) {
            throw new Error('Invalid native genesis ABI state');
        }
        accounts.add(state.account); ordinals.add(state.deltaOrdinal);
        return Object.freeze({account: state.account, present: true, abiHex: state.abiHex, deltaOrdinal: state.deltaOrdinal});
    });
    return Object.freeze({schemaVersion: 1, previousBlockId: zeroBlockId, applicationState: 'empty', abiStates: Object.freeze(abiStates)});
}

/** Re-run the installed pure verifier from retained original sections; journaled facts alone grant nothing. */
export function verifyNativeGenesisRecord(record: ProtocolAbiObservationRecord,
                                          verifier: ProtocolNativeGenesisVerifier | undefined): ProtocolNativeGenesisFacts {
    const {source, capture, observation} = record;
    if (!verifier || observation.status !== 'native-genesis' || source.blockNum !== 1 || source.previousBlockId !== null
        || capture.schemaJson === null || !capture.blockHex || capture.tracesHex !== null || !capture.deltasHex) {
        throw new Error('Native genesis requires its selected verifier and complete original header/state sections');
    }
    const retained = snapshotNativeGenesisFacts(observation.facts);
    const verified = snapshotNativeGenesisFacts(verifier({schemaJson: capture.schemaJson,
        block: Buffer.from(capture.blockHex, 'hex'), traces: null, deltas: Buffer.from(capture.deltasHex, 'hex')},
    {chainId: source.chainId, blockNum: source.blockNum, blockId: source.blockId, previousBlockId: source.previousBlockId}));
    if (protocolAbiObservationJson(retained) !== protocolAbiObservationJson(verified)) {
        throw new Error('Journaled native genesis facts differ from retained source verification');
    }
    return verified;
}

/** The header predecessor is separate from the absent SHiP prev_block source position. */
export function validNativeGenesisCoverage(value: unknown): value is ProtocolNativeGenesisCoverage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const facts = value as ProtocolNativeGenesisCoverage;
    return facts.previousBlockId === zeroBlockId && facts.applicationState === 'empty'
        && Object.keys(facts).length === 2;
}
