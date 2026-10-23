import type {ProtocolNativeActionProofMetadata} from '../../indexer/protocol/native-authorization.js';
import type {ProtocolAbiProofView} from '../../indexer/protocol/abi-proof.js';
import {ProtocolAbiProofUnavailableError} from '../../indexer/protocol/abi-proof.js';
import {protocolImmutableJson} from '../../indexer/protocol/immutable-bundle-store.js';

export interface NativeOutputEvidence {
    readonly metadata: ProtocolNativeActionProofMetadata;
    readonly value: unknown;
    readonly envelope: Readonly<Record<string, any>>;
    readonly membership: ProtocolAbiProofView;
    readonly presentation?: 'noBinary';
    readonly dataMode?: 'raw';
}
export interface NativeOutputObligation {
    readonly proof: NativeOutputEvidence;
    readonly envelope: Record<string, any>;
    readonly value: unknown;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (left: unknown, right: unknown) => protocolImmutableJson(left, 64 * 1024 * 1024)
    === protocolImmutableJson(right, 64 * 1024 * 1024);
function requireOutput(condition: unknown): asserts condition {
    if (!condition) throw new ProtocolAbiProofUnavailableError('native_output_mismatch',
        'Protocol native output differs from its checked original occurrence');
}

/** The existing get_actions renderer deliberately abbreviates only long top-level strings. */
function renderedValue(proof: NativeOutputEvidence): unknown {
    if (proof.dataMode === 'raw') {
        requireOutput((proof.envelope.act as any).data === proof.metadata.input.rawHex);
        return proof.metadata.input.rawHex;
    }
    if (proof.presentation !== 'noBinary') return proof.value;
    const value: any = copy(proof.value);
    if (value && typeof value === 'object') for (const key of Object.keys(value)) {
        if (typeof value[key] === 'string' && value[key].length > 256) value[key] = value[key].slice(0, 32) + '...';
    }
    return value;
}

function originalReceipt(proof: NativeOutputEvidence, receipt: any): any {
    const result = copy(receipt);
    // The v1 transaction renderer adds this redundant action digest to its original receipt.
    if (Object.hasOwn(result, 'act_digest')) {
        requireOutput(result.act_digest === proof.envelope.act_digest); delete result.act_digest;
    }
    return result;
}
function checkAct(proof: NativeOutputEvidence, act: any): void {
    requireOutput(act && act.account === proof.metadata.input.account && act.name === proof.metadata.input.name
        && equal(act.authorization, (proof.envelope.act as any).authorization)
        && equal(act.data, renderedValue(proof)));
    if (act.hex_data !== undefined) requireOutput(act.hex_data === proof.metadata.input.rawHex);
    if (act.hex_encoder !== undefined) requireOutput(act.hex_encoder === proof.metadata.native.profile.id);
}
const valueForEncoding = (proof: NativeOutputEvidence, actual: unknown) => proof.presentation || proof.dataMode ? proof.value : actual;
function withReceipt(proof: NativeOutputEvidence, envelope: Record<string, any>, receipt: any): void {
    const original = originalReceipt(proof, receipt);
    envelope.receipts = [original, ...envelope.receipts.filter((entry: any) => entry.global_sequence !== original.global_sequence)];
}

/** Snapshot callers own these values. This authenticates the source object even when a derived route drops it. */
export function nativeSourceOutput(proof: NativeOutputEvidence, source: any): NativeOutputObligation {
    checkAct(proof, source.act);
    const envelope = copy(source);
    if (envelope.protocol !== undefined) requireOutput(equal(envelope.protocol, proof.metadata));
    envelope.protocol = proof.metadata;
    envelope.receipts = envelope.receipts.map((receipt: any) => originalReceipt(proof, receipt));
    return {proof, envelope, value: valueForEncoding(proof, source.act.data)};
}

/** Recognize only the existing action renderers; these locators select checked evidence, never native authority. */
export function nativeResponseOutputs(body: any, evidence: readonly NativeOutputEvidence[]): NativeOutputObligation[] {
    const candidates: any[] = [
        ...(body.actions ?? []).map((entry: any) => {const action = entry.action_trace ?? entry; return {kind: entry.action_trace ? 'v1-action' : 'full',
            action, wrapper: entry, account: action.act?.account, name: action.act?.name, trx: action.trx_id, block: action.block_num,
            ordinal: action.action_ordinal, sequence: entry.global_action_seq ?? action.global_sequence};}),
        ...(body.traces ?? []).map((action: any) => ({kind: 'v1-trace', action, account: action.act?.account, name: action.act?.name,
            trx: action.trx_id ?? body.id, block: action.block_num, sequence: action.receipt?.global_sequence})),
        ...(body.simple_actions ?? []).map((action: any) => ({kind: 'simple', action, account: action.contract, name: action.action,
            trx: action.transaction_id, block: action.block})),
        ...(body.transactions ?? []).flatMap((transaction: any) => (transaction.actions ?? []).map((action: any) => ({kind: 'trace-action',
            action, account: action.account, name: action.action, trx: transaction.id, block: body.number, receiver: action.receiver}))),
    ];
    const obligations: NativeOutputObligation[] = [];
    for (const candidate of candidates) {
        const alternatives = evidence.filter(proof => {
            const input = proof.metadata.input;
            if (candidate.account !== input.account || candidate.name !== input.name || candidate.trx !== input.transactionId
                || candidate.block !== proof.metadata.source.blockNum
                || (candidate.ordinal !== undefined && candidate.ordinal !== input.actionOrdinal)) return false;
            if (candidate.sequence !== undefined && candidate.kind !== 'v1-trace') return candidate.sequence === input.globalSequence;
            return proof.membership.bindings.some(binding => binding.transactionId === input.transactionId
                && binding.inputActionOrdinal === input.inputActionOrdinal && binding.account === input.account && binding.name === input.name
                && (candidate.sequence === undefined || candidate.sequence === binding.globalSequence)
                && (candidate.receiver === undefined || candidate.receiver === binding.receiver));
        });
        if (!alternatives.length) continue; // Contract/raw coverage is checked by the shared occurrence guard.
        let checked: NativeOutputObligation | undefined;
        // Simple/block-trace formats intentionally omit ordinals. Match every exposed value/receipt/actor
        // field before selecting a grant, so independent identical inputs do not bind to the first origin.
        for (const proof of alternatives) {
            try {
                const action = candidate.action, envelope: any = copy(proof.envelope);
                if (candidate.kind === 'full') {checked = nativeSourceOutput(proof, action); break;}
                envelope.protocol = proof.metadata;
                envelope.block_num = candidate.block; envelope.trx_id = candidate.trx;
                if (candidate.kind === 'v1-action' || candidate.kind === 'v1-trace') {
                    checkAct(proof, action.act); envelope.act = action.act;
                    withReceipt(proof, envelope, action.receipt);
                    if (candidate.kind === 'v1-action') {
                        envelope.action_ordinal = action.action_ordinal; envelope.creator_action_ordinal = action.creator_action_ordinal;
                        envelope.global_sequence = candidate.sequence;
                        requireOutput(action.receiver === action.receipt.receiver
                            && candidate.wrapper.account_action_seq === action.receipt.recv_sequence
                            && candidate.wrapper.block_num === candidate.block);
                    }
                } else if (candidate.kind === 'simple') {
                    requireOutput(equal(action.data, renderedValue(proof))
                        && action.actors === (envelope.act.authorization as any[]).map(auth => `${auth.actor}@${auth.permission}`).join(',')
                        && action.notified === [...new Set(envelope.receipts.map((receipt: any) => receipt.receiver))].join(','));
                } else {
                    requireOutput(equal(action.data, renderedValue(proof)) && equal(action.authorization,
                        (envelope.act.authorization as any[]).map(auth => ({account: auth.actor, permission: auth.permission}))));
                }
                const actual = candidate.kind === 'v1-action' || candidate.kind === 'v1-trace' ? action.act.data : action.data;
                checked = {proof, envelope, value: valueForEncoding(proof, actual)}; break;
            } catch (error) {
                if (!(error instanceof ProtocolAbiProofUnavailableError) || error.code !== 'native_output_mismatch') throw error;
            }
        }
        requireOutput(checked); obligations.push(checked);
    }
    return obligations;
}

/** Derived values bind to the producer's captured native set before its source objects are shaped away. */
export function assertNativeDerivedOutput(route: string, body: any, evidence: readonly NativeOutputEvidence[], mixedContract: boolean): void {
    if (!evidence.length) return;
    const account = (proof: NativeOutputEvidence) => {
        const act = proof.envelope.act as any, value: any = proof.value;
        return act.name === 'newaccount' ? value?.newact ?? value?.name : act.name === 'updateauth' ? value?.account : null;
    };
    if (route === 'get_controlled_accounts' || route === 'get_key_accounts') {
        const expected = [...new Set(evidence.map(account))], actual = body[route === 'get_key_accounts' ? 'account_names' : 'controlled_accounts'];
        requireOutput(Array.isArray(actual) && (mixedContract ? expected.every(value => actual.includes(value)) : equal(actual, expected)));
    } else if (route === 'get_creator') {
        requireOutput(evidence.some(proof => body.creator === (proof.value as any)?.creator
            && body.block_num === proof.metadata.source.blockNum && (body.trx_id === undefined || body.trx_id === proof.metadata.input.transactionId)));
    } else if (route === 'get_created_accounts') {
        const expected = evidence.map(proof => ({name: (proof.value as any)?.newact ?? (proof.value as any)?.name,
            trx_id: proof.metadata.input.transactionId}));
        const actual = (body.accounts ?? []).map((entry: any) => ({name: entry.name, trx_id: entry.trx_id}));
        requireOutput(mixedContract ? expected.every(value => actual.some((entry: any) => equal(entry, value))) : equal(actual, expected));
    }
}
