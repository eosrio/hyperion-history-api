import {createHash} from 'node:crypto';
import {validateProtocolNativeActionObservations, protocolNativeActionBounds,
    type ProtocolAbiActionInput, type ProtocolNativeActionObservations} from '@eosrio/hyperion-sdk/protocol';
import {assertProtocolAbiObservationFacts} from './abi-observation-facts.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';

export interface ProtocolNativeInputInventory {
    readonly schemaVersion: 1;
    readonly inputCount: number;
    readonly firstReceiverCount: number;
    readonly sha256: string;
}

function originalInputs(inputs: readonly ProtocolAbiActionInput[]): readonly ProtocolAbiActionInput[] {
    assertProtocolAbiObservationFacts({schemaVersion: 1, actionInputs: inputs, deployments: [], finalStates: []});
    if (inputs.length > protocolNativeActionBounds.decisions) throw new Error('Native source input count exceeds its bound');
    const seen = new Set<string>();
    for (const input of inputs) {
        const key = input.transactionId + ':' + input.actionOrdinal;
        if (seen.has(key)) throw new Error('Repeated original native source occurrence');
        seen.add(key);
    }
    return inputs;
}
const firstReceivers = (inputs: readonly ProtocolAbiActionInput[]) => inputs.filter(input =>
    input.receiver === input.account && input.inputActionOrdinal === input.actionOrdinal);

/** Binds all host-derived rows in retained transaction/action-vector order, including notifications. */
export function protocolNativeInputInventory(inputs: readonly ProtocolAbiActionInput[]): ProtocolNativeInputInventory {
    const rows = originalInputs(inputs);
    const bytes = protocolImmutableJson(['hyperion-native-action-input-inventory-v1', rows], 64 * 1024 * 1024);
    return Object.freeze({schemaVersion: 1, inputCount: rows.length, firstReceiverCount: firstReceivers(rows).length,
        sha256: createHash('sha256').update(bytes).digest('hex')});
}

/** Detached labels only. Original source and fresh canonical authority remain separate requirements. */
export function snapshotProtocolNativeDecisions(value: unknown,
    inputs: readonly ProtocolAbiActionInput[]): ProtocolNativeActionObservations {
    const expected = firstReceivers(originalInputs(inputs));
    const checked = validateProtocolNativeActionObservations(value);
    if (!checked.valid) throw new Error('Invalid native observations: ' + checked.errors.map(error => error.message).join('; '));
    if (checked.observations.decisions.length !== expected.length) throw new Error('Incomplete native first-receiver decisions');
    const decisions = new Map(checked.observations.decisions.map(decision =>
        [decision.origin.transactionId + ':' + decision.origin.actionOrdinal, decision]));
    const ordered = expected.map(input => {
        const key = input.transactionId + ':' + input.actionOrdinal, decision = decisions.get(key);
        const rawSha256 = createHash('sha256').update(Buffer.from(input.rawHex, 'hex')).digest('hex');
        if (!decision || decision.origin.rawSha256 !== rawSha256) throw new Error('Native decision differs from the original first receiver');
        decisions.delete(key);
        return decision;
    });
    if (decisions.size) throw new Error('Unplanned native first-receiver decisions');
    return Object.freeze({schemaVersion: 1, decisions: Object.freeze(ordered)});
}
