import {ABI, Name, Serializer} from '@wharfkit/antelope';
import type {ProtocolAbiActionInput, ProtocolBlockAbiInput, ProtocolBlockAbiObservations, ProtocolBlockAbiSource} from '@eosrio/hyperion-sdk/protocol';

const accountAbi = ABI.from({version: 'eosio::abi/1.2', structs: [{name: 'account_v0', base: '', fields: [
    {name: 'name', type: 'name'}, {name: 'creation_date', type: 'block_timestamp_type'}, {name: 'abi', type: 'bytes'}]}],
    variants: [{name: 'account', types: ['account_v0']}]});
function check(condition: unknown, message: string): asserts condition {if (!condition) throw new Error(message);}
function record(value: any): Record<string, any> {
    check(value && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Malformed Antelope observation record');
    return value;
}
/** Bound the full input and reject accessors before inspecting any of its provider fields. */
function inspect(input: unknown): void {
    const stack: Array<[unknown, number]> = [[input, 0]]; let nodes = 0, text = 0;
    while (stack.length) {
        const [value, depth] = stack.pop()!;
        check(++nodes <= 1_000_000 && depth <= 256, 'Antelope observation traversal exceeds limit');
        if (typeof value === 'string') text += Buffer.byteLength(value);
        else if (value instanceof Uint8Array) text += value.byteLength * 2;
        else if (value && typeof value === 'object') {
            check(Object.getOwnPropertySymbols(value).length === 0, 'Symbol in Antelope observation');
            if (Array.isArray(value)) check(value.length <= 1_000_000 && Object.keys(value).length === value.length, 'Malformed Antelope observation array');
            else record(value);
            for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
                check(Object.hasOwn(descriptor, 'value'), 'Accessor in Antelope observation');
                if (Array.isArray(value) && key === 'length') continue;
                text += Buffer.byteLength(key); stack.push([descriptor.value, depth + 1]);
            }
        } else check(value === null || value === undefined || typeof value === 'boolean'
            || typeof value === 'number' && Number.isFinite(value), 'Unsupported Antelope observation value');
        check(text <= 64 * 1024 * 1024, 'Antelope observation text exceeds limit');
    }
}
function variant(value: any, allowed: readonly string[]): Record<string, any> {
    check(Array.isArray(value) && value.length === 2 && allowed.includes(value[0]), 'Unsupported Antelope observation variant');
    return record(value[1]);
}
function ordinal(value: any, minimum = 0): number {
    check(Number.isSafeInteger(value) && value >= minimum && value <= 0xffffffff, 'Invalid Antelope source ordinal'); return value;
}
function digest(value: unknown): void {check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'Invalid Antelope source digest');}
function name(value: any, empty = false): string {
    check(typeof value === 'string' && (empty || value.length > 0) && Name.from(value).toString() === value, 'Invalid Antelope source name'); return value;
}
function hex(value: any): string {
    check(typeof value === 'string' && value.length % 2 === 0 && !/[^0-9a-f]/.test(value), 'Invalid Antelope source hex'); return value;
}
function sequence(value: unknown, bits: 32 | 64): string {
    if (bits === 32 && typeof value === 'number') {ordinal(value); return String(value);}
    check(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && value.length <= 20, 'Expected lossless Antelope receipt sequence');
    const parsed = BigInt(value);
    check(parsed <= (bits === 32 ? 0xffffffffn : 0xffffffffffffffffn) && (bits !== 64 || parsed > 0n), 'Antelope receipt sequence out of range');
    return value;
}
function flag(value: unknown): boolean {
    check(value === true || value === false || value === 0 || value === 1, 'Invalid Antelope source flag'); return value === true || value === 1;
}
/** Leap v5.0.3 action::data_as/setabi uses fc::raw prefix unpack, not ABI-body or trailing-byte validation. */
function nativeAbi(rawHex: string) {
    const bytes = Buffer.from(rawHex, 'hex'); check(bytes.length >= 9, 'Truncated Antelope setabi input');
    const account = name(Serializer.decode({data: bytes.subarray(0, 8), type: 'name'}).toString());
    let size = 0, offset = 8;
    for (let index = 0; index < 5; index++) {
        check(offset < bytes.length, 'Truncated Antelope setabi vector');
        const byte = bytes[offset++]; size = (size | ((byte & 127) << (7 * index))) >>> 0;
        if (!(byte & 128)) break;
    }
    check(size <= bytes.length - offset, 'Truncated Antelope setabi ABI bytes');
    return {account, abiHex: bytes.subarray(offset, offset + size).toString('hex')};
}

/** Antelope source facts only; canonical membership, ABI applicability and readiness belong to the host. */
export function observeAntelopeBlockAbi(input: ProtocolBlockAbiInput, source: ProtocolBlockAbiSource): ProtocolBlockAbiObservations {
    inspect(input); inspect(source); record(input); record(source);
    digest(source.chainId); digest(source.blockId); if (source.previousBlockId !== null) digest(source.previousBlockId); ordinal(source.blockNum, 1);
    check(Array.isArray(input.traces) && Array.isArray(input.accountRows), 'Missing Antelope ABI observation input');
    const actionInputs: ProtocolAbiActionInput[] = [], deployments: ProtocolBlockAbiObservations['deployments'][number][] = [];
    const seenTransactions = new Set<string>(), seenSequences = new Set<string>();
    for (const item of input.traces) {
        const transaction = variant(item, ['transaction_trace_v0']); digest(transaction.id);
        check(!seenTransactions.has(transaction.id), 'Duplicate Antelope source transaction'); seenTransactions.add(transaction.id);
        check(transaction.status === 0 && transaction.failed_dtrx_trace === null && transaction.except === null
            && transaction.error_code === null, 'Unsupported committed Antelope transaction semantics');
        flag(transaction.scheduled); check(Array.isArray(transaction.action_traces), 'Missing Antelope action traces');
        const occurrences = new Map<number, {fact: Omit<ProtocolAbiActionInput, 'inputActionOrdinal'>; creator: number; contextFree: boolean; identity: string}>();
        for (const value of transaction.action_traces) {
            const trace = variant(value, ['action_trace_v0', 'action_trace_v1']);
            const actionOrdinal = ordinal(trace.action_ordinal, 1), creator = ordinal(trace.creator_action_ordinal);
            check(!occurrences.has(actionOrdinal), 'Duplicate Antelope action ordinal');
            check(trace.except === null && trace.error_code === null, 'Failed Antelope action is not a committed ABI source');
            const receipt = variant(trace.receipt, ['action_receipt_v0']), receiver = name(trace.receiver);
            check(name(receipt.receiver) === receiver, 'Antelope receipt receiver mismatch');
            const globalSequence = sequence(receipt.global_sequence, 64);
            check(!seenSequences.has(globalSequence), 'Duplicate Antelope global sequence'); seenSequences.add(globalSequence);
            const action = record(trace.act), account = name(action.account), actionName = name(action.name, true);
            const rawHex = hex(action.data), contextFree = flag(trace.context_free);
            check(Array.isArray(action.authorization), 'Invalid Antelope authorization');
            const authorization = action.authorization.map((entry: any) => {const value = record(entry); return [name(value.actor), name(value.permission)];});
            occurrences.set(actionOrdinal, {creator, contextFree, identity: JSON.stringify([account, actionName, authorization, rawHex, contextFree]),
                fact: {transactionId: transaction.id, actionOrdinal, receiver, account, name: actionName, rawHex,
                    globalSequence, receiptAbiSequence: sequence(receipt.abi_sequence, 32)}});
        }
        for (const entry of occurrences.values()) if (entry.creator !== 0) {
            const parent = occurrences.get(entry.creator);
            check(parent && BigInt(parent.fact.globalSequence) < BigInt(entry.fact.globalSequence), 'Missing, cyclic or unordered Antelope creator ancestry');
        }
        const origins = new Map<number, number>();
        for (const entry of occurrences.values()) {
            let current = entry; const path: number[] = [];
            while (!origins.has(current.fact.actionOrdinal) && current.fact.receiver !== current.fact.account) {
                check(path.length < 256, 'Antelope notification ancestry exceeds limit'); path.push(current.fact.actionOrdinal);
                const parent = occurrences.get(current.creator);
                check(parent && parent.identity === current.identity, 'Notification does not match its originating Antelope action input'); current = parent;
            }
            const inputActionOrdinal = origins.get(current.fact.actionOrdinal) ?? current.fact.actionOrdinal;
            origins.set(current.fact.actionOrdinal, inputActionOrdinal); for (const number of path) origins.set(number, inputActionOrdinal);
            const fact = {...entry.fact, inputActionOrdinal}; actionInputs.push(fact);
            if (fact.receiver === 'eosio' && fact.account === 'eosio' && fact.name === 'setabi') {
                check(!entry.contextFree, 'Context-free Antelope native ABI mutation is unsupported');
                deployments.push({...nativeAbi(fact.rawHex), action: {transactionId: fact.transactionId, actionOrdinal: fact.actionOrdinal},
                    globalSequence: fact.globalSequence, effect: 'native-before-receipt'});
            }
        }
    }
    const seenRows = new Set<number>(), seenAccounts = new Set<string>();
    const finalStates = input.accountRows.map(row => {
        record(row); const deltaOrdinal = ordinal(row.ordinal);
        check(!seenRows.has(deltaOrdinal), 'Duplicate Antelope account row ordinal'); seenRows.add(deltaOrdinal);
        check(typeof row.present === 'boolean' && row.raw instanceof Uint8Array, 'Invalid Antelope source account row');
        const decoded = variant(Serializer.objectify(Serializer.decode({data: row.raw, type: 'account', abi: accountAbi})), ['account_v0']);
        const encoded = Serializer.encode({object: row.value, type: 'account', abi: accountAbi}).array;
        check(Buffer.from(encoded).equals(Buffer.from(row.raw)), 'Antelope account row does not match its raw bytes');
        const account = name(decoded.name); check(!seenAccounts.has(account), 'Duplicate final Antelope account state'); seenAccounts.add(account);
        return {account, present: row.present, abiHex: hex(decoded.abi), deltaOrdinal};
    });
    const order = (left: {globalSequence: string}, right: {globalSequence: string}) => BigInt(left.globalSequence) < BigInt(right.globalSequence) ? -1 : 1;
    return {schemaVersion: 1, actionInputs: actionInputs.sort(order), deployments: deployments.sort(order), finalStates: finalStates.sort((a, b) => a.deltaOrdinal - b.deltaOrdinal)};
}
