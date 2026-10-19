import type {ProtocolBlockAbiObservations} from '@eosrio/hyperion-sdk/protocol';
import {protocolAbiObservationJson} from './abi-observation-store.js';

/** Validate portable SDK shapes only; ABI bodies and canonical applicability remain unexamined. */
export function assertProtocolAbiObservationFacts(value: unknown): asserts value is ProtocolBlockAbiObservations {
    // Reject accessors before reading any provider fields.
    protocolAbiObservationJson(value, 64 * 1024 * 1024);
    const record = (input: any) => input && typeof input === 'object' && !Array.isArray(input);
    const text = (input: any) => typeof input === 'string' && input.length > 0 && input.length <= 256;
    const integer = (input: any, minimum = 0) => Number.isSafeInteger(input) && input >= minimum;
    const hex = (input: any) => typeof input === 'string' && /^(?:[0-9a-f]{2})*$/.test(input);
    const decimal = (input: any, maximum: bigint, minimum = 0n) => typeof input === 'string' && input.length <= 20
        && /^(?:0|[1-9][0-9]*)$/.test(input) && BigInt(input) >= minimum && BigInt(input) <= maximum;
    const anchor = (input: any) => record(input) && typeof input.transactionId === 'string'
        && /^[0-9a-f]{64}$/.test(input.transactionId) && integer(input.actionOrdinal, 1);
    const facts: any = value;
    if (!record(facts) || facts.schemaVersion !== 1 || !Array.isArray(facts.actionInputs)
        || !Array.isArray(facts.deployments) || !Array.isArray(facts.finalStates)
        || facts.actionInputs.some((entry: any) => !anchor(entry) || !text(entry.receiver) || !text(entry.account)
            || typeof entry.name !== 'string' || entry.name.length > 256
            || !hex(entry.rawHex) || !decimal(entry.globalSequence, 0xffffffffffffffffn, 1n)
            || !decimal(entry.receiptAbiSequence, 0xffffffffn) || !integer(entry.inputActionOrdinal, 1))
        || facts.deployments.some((entry: any) => !record(entry) || !text(entry.account) || !hex(entry.abiHex) || !anchor(entry.action)
            || !decimal(entry.globalSequence, 0xffffffffffffffffn, 1n) || entry.effect !== 'native-before-receipt')
        || facts.finalStates.some((entry: any) => !record(entry) || !text(entry.account) || typeof entry.present !== 'boolean'
            || !hex(entry.abiHex) || !integer(entry.deltaOrdinal))) throw new Error('Invalid provider ABI observation facts');
}
