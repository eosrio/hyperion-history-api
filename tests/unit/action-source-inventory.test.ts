import {describe, expect, it} from 'bun:test';
import {createHash} from 'node:crypto';
import {deriveActionSourceInventory, validateActionSourceTransactionOutput, ActionSourceInventoryError,
    type ActionSourceInventoryInput, type ActionSourceInventoryProfile} from '../../src/indexer/history/action-source-inventory.js';
import {actionHistoryImmutableJson} from '../../src/indexer/history/action-history-manifest.js';
import {normalizeActionSequences} from '../../src/indexer/helpers/action-sequences.js';
import {groupActionTraces} from '../../src/indexer/helpers/action-dedup.js';

const txid = 'a'.repeat(64), secondId = 'b'.repeat(64), blockId = 'c'.repeat(64), chainId = 'd'.repeat(64);
const digest = 'e'.repeat(64), selectionId = 'h45srcsel1:' + 'f'.repeat(64);
const clone = <T>(value: T): T => structuredClone(value);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type TestInput = {-readonly [Key in keyof ActionSourceInventoryInput]: ActionSourceInventoryInput[Key]};
function action(ordinal = 1, creator = 0, receiver = 'token', sequence = String(100 + ordinal)): any {
    return ['action_trace_v0', {action_ordinal: ordinal, creator_action_ordinal: creator, receiver,
        receipt: ['action_receipt_v0', {receiver, act_digest: digest, global_sequence: sequence,
            recv_sequence: String(ordinal), auth_sequence: [{account: 'alice', sequence: String(ordinal + 10)}],
            code_sequence: ordinal, abi_sequence: ordinal + 20}],
        act: {account: 'token', name: 'transfer', authorization: [{actor: 'alice', permission: 'active'}], data: '0102'},
        context_free: false, except: null, error_code: null, elapsed: '0', console: ''}];
}
function transaction(actions: any[], id = txid): any {
    return ['transaction_trace_v0', {id, status: 0, scheduled: false, failed_dtrx_trace: null, except: null,
        error_code: null, cpu_usage_us: 15, net_usage_words: 2, action_traces: actions, partial: null}];
}
function input(actions: any[] = [action()]): TestInput {
    return {profileId: 'antelope-default-v1', source: {chainId, blockNum: 12, blockId, producer: 'producer',
        timestamp: '2026-10-20T00:00:00.000'}, policy: {schemaVersion: 1, parserVersion: '3.2',
        actionBlacklist: [], actionWhitelist: [], rootOnly: false, maxDepth: 0, maxInline: 0, eosioAlias: 'eosio'},
        traces: [transaction(actions)]};
}
function wireInput(profileId: ActionSourceInventoryProfile, actions: any[] = [action(1), action(2, 1, 'alice')]): TestInput {
    const result = input(actions);
    return {...result, profileId, sourceSelectionId: selectionId, wireActionInputs: actions.map(([, value]) => ({
        transactionId: txid, actionOrdinal: value.action_ordinal, inputActionOrdinal: value.receiver === value.act.account ? value.action_ordinal : 1,
        receiver: value.receiver, account: value.act.account, name: value.act.name, rawHex: value.act.data,
        globalSequence: value.receipt[1].global_sequence, receiptAbiSequence: String(value.receipt[1].abi_sequence)}))};
}

/** Exercise the existing grouping helper as the independent final-document oracle.
 * Explicit ordinals choose parser-surviving occurrences; this helper does not derive filter expectations. */
function emit(value: ActionSourceInventoryInput, ordinals: number[], transactionIndex = 0): any[] {
    const trace = clone((value.traces as any[])[transactionIndex][1]);
    const retainedCount = value.policy.maxInline ? Math.min(value.policy.maxInline, trace.action_traces.length) : trace.action_traces.length;
    const processed: any[] = [];
    let usageIncluded = false;
    for (const [, source] of trace.action_traces) {
        if (!ordinals.includes(source.action_ordinal) || source.except !== null) continue;
        const result = source;
        normalizeActionSequences(result);
        result.global_sequence = result.receipt[1].global_sequence;
        result.receipt = result.receipt[1];
        result['@timestamp'] = value.source.timestamp; result.block_num = value.source.blockNum;
        result.block_id = value.source.blockId; result.producer = value.source.producer; result.trx_id = trace.id;
        delete result.except;
        if (result.error_code === null) delete result.error_code;
        if (value.profileId !== 'antelope-default-v1') result.protocol = {schemaVersion: 1,
            source: {chainId: value.source.chainId, blockNum: value.source.blockNum, blockId: value.source.blockId},
            selectionId: value.sourceSelectionId,
            input: value.wireActionInputs!.find(fact => fact.transactionId === trace.id && fact.actionOrdinal === result.action_ordinal)};
        if (!usageIncluded) {
            result.cpu_usage_us = trace.cpu_usage_us; result.net_usage_words = trace.net_usage_words;
            result.signatures = trace.partial?.[1]?.signatures ?? [];
            if (retainedCount > 1) {
                result.inline_count = trace.action_traces.length - 1;
                result.inline_filtered = retainedCount < trace.action_traces.length;
                if (result.inline_filtered) result.max_inline = value.policy.maxInline;
            } else result.inline_count = 0;
            usageIncluded = !(result.act.account === value.policy.eosioAlias + '.null' && result.act.name === 'nonce');
        }
        processed.push(result);
    }
    const grouped = groupActionTraces(processed as any, value.profileId !== 'antelope-default-v1') as any[];
    for (const result of grouped) {
        result.act_digest = result.receipts[0].act_digest;
        for (const receipt of result.receipts) delete receipt.act_digest;
        delete result.receiver;
        if (result.context_free === false) delete result.context_free;
        if (result.elapsed === '0') delete result.elapsed;
        if (result.signatures?.length === 0) delete result.signatures;
        if (result.inline_count === 0) delete result.inline_count;
        if (result.net_usage_words === 0) delete result.net_usage_words;
        result.act.data = {amount: 1.25, global_sequence: 'opaque-contract-data'};
    }
    return grouped;
}

describe('source-derived action inventory', () => {
    it('preserves complete original transaction order, including empty and excluded transactions', () => {
        const value = input();
        value.traces = [transaction([], secondId), transaction([action()])];
        const inventory = deriveActionSourceInventory(value);
        expect(inventory.transactions.map(value => [value.transactionId, value.traceOrdinal, value.disposition])).toEqual([
            [secondId, 0, 'no-effects'], [txid, 1, 'process']]);
        expect(inventory.transactions[0].dispatch).toBeNull();
        expect(validateActionSourceTransactionOutput(inventory, 0, [])).toEqual([]);
        expect(validateActionSourceTransactionOutput(inventory, 1, emit(value, [1], 1))).toHaveLength(1);
    });

    it('requires a real decoded trace vector and rejects unsupported statuses even when filters exclude it', () => {
        for (const traces of [null, undefined, {}, ['wrong']]) expect(() => deriveActionSourceInventory({...input(), traces})).toThrow(ActionSourceInventoryError);
        for (const patch of [{status: 1}, {scheduled: true}, {failed_dtrx_trace: ['transaction_trace_v0', {}]}, {except: 'failed'}, {error_code: '1'}]) {
            const value = input(); Object.assign((value.traces as any[])[0][1], patch);
            value.policy = {...value.policy, actionBlacklist: ['token::*']};
            expect(() => deriveActionSourceInventory(value)).toThrow('Unsupported source transaction');
        }
        expect(deriveActionSourceInventory({...input(), traces: []}).transactions).toEqual([]);
    });

    it('pins original trace hash separately from canonical truncated dispatch bytes without mutation', () => {
        const value = input([action(5), action(8, 5, 'alice'), action(13, 5, 'bob')]);
        value.policy = {...value.policy, maxInline: 2};
        const original = clone(value), inventory = deriveActionSourceInventory(value), tx = inventory.transactions[0];
        expect(tx.traceSha256).toBe(sha(actionHistoryImmutableJson((value.traces as any[])[0])));
        expect(tx.dispatch!.actionOrdinals).toEqual([5, 8]);
        expect(tx.dispatch!.inlineCount).toBe(3); expect(tx.dispatch!.filtered).toBe(true);
        expect(tx.dispatch!.bodySha256).toBe(sha(tx.dispatch!.canonicalJson));
        expect(tx.dispatch!.bodySha256).not.toBe(tx.traceSha256);
        expect(tx.occurrences.map(value => [value.sourceOrdinal, value.actionOrdinal, value.reason])).toEqual([
            [0, 5, null], [1, 8, null], [2, 13, 'max-inline']]);
        expect(JSON.parse(tx.dispatch!.canonicalJson)).toEqual(tx.dispatch!.body);
        expect(value).toEqual(original);
        expect(Object.isFrozen(tx.dispatch!.body)).toBe(true);
        expect(validateActionSourceTransactionOutput(inventory, 0, emit(value, [5, 8]))).toHaveLength(1);
    });

    it('uses eligible packed-block roots, not trace roots, for root-only decisions', () => {
        const value = input();
        value.policy = {...value.policy, rootOnly: true, actionWhitelist: ['token::*']};
        expect(() => deriveActionSourceInventory(value)).toThrow('Root-only requires');
        value.rootActions = [{account: 'other', name: 'transfer'}];
        const excluded = deriveActionSourceInventory(value);
        expect(excluded.rootAllowed).toBe(false); expect(excluded.transactions[0].disposition).toBe('excluded');
        expect(excluded.transactions[0].occurrences[0].reason).toBe('root-only');
        expect(excluded.transactions[0].traceOrdinal).toBe(0);
        expect(validateActionSourceTransactionOutput(excluded, 0, [])).toEqual([]);
        value.rootActions = [{account: 'token', name: 'transfer'}];
        expect(deriveActionSourceInventory(value).rootAllowed).toBe(true);
        value.rootActions = [{account: 'token', name: 'transfer'}, {account: null as any, name: 'bad'}];
        expect(() => deriveActionSourceInventory(value)).toThrow(ActionSourceInventoryError);
    });

    it('applies transaction and per-action blacklist semantics before grouping', () => {
        const first = action(1), second = action(2, 0); second[1].act.account = 'other'; second[1].receiver = 'other'; second[1].receipt[1].receiver = 'other';
        const value = input([first, second]);
        value.policy = {...value.policy, actionBlacklist: ['token::transfer']};
        const blocked = deriveActionSourceInventory(value).transactions[0];
        expect(blocked.disposition).toBe('excluded'); expect(blocked.dispatch).toBeNull();
        value.policy = {...value.policy, actionBlacklist: ['other::*']};
        const inventory = deriveActionSourceInventory(value);
        expect(inventory.transactions[0].parsedActionCount).toBe(1);
        expect(inventory.transactions[0].groups[0].actionOrdinals).toEqual([1]);
        expect(inventory.transactions[0].occurrences[1].reason).toBe('action-filter');
        expect(validateActionSourceTransactionOutput(inventory, 0, emit(value, [1]))).toHaveLength(1);
    });

    it('preserves max-depth boundary and max-inline-before-route semantics', () => {
        const actions = [action(1), action(2, 0), action(3, 0)];
        actions[1][1].act.name = 'chosen'; actions[2][1].act.name = 'last';
        const value = input(actions);
        value.policy = {...value.policy, actionWhitelist: ['*::chosen'], maxDepth: 1};
        let inventory = deriveActionSourceInventory(value);
        expect(inventory.transactions[0].groups[0].representativeActionOrdinal).toBe(2);
        expect(validateActionSourceTransactionOutput(inventory, 0, emit(value, [2]))).toHaveLength(1);
        value.policy = {...value.policy, actionWhitelist: ['*::last']};
        expect(deriveActionSourceInventory(value).transactions[0].disposition).toBe('excluded');
        value.policy = {...value.policy, actionWhitelist: ['*::chosen'], maxDepth: 0, maxInline: 1};
        expect(deriveActionSourceInventory(value).transactions[0].disposition).toBe('excluded');
    });

    it('keeps original ordinals and accounts for excluded origin occurrences', () => {
        const actions = [action(1), action(2, 1, 'alice')];
        actions[0][1].act.name = 'excluded';
        const value = input(actions);
        value.policy = {...value.policy, actionWhitelist: ['token::transfer']};
        const inventory = deriveActionSourceInventory(value);
        expect(inventory.transactions[0].dispatch!.actionOrdinals).toEqual([1, 2]);
        expect(inventory.transactions[0].groups[0].actionOrdinals).toEqual([2]);
        expect(inventory.transactions[0].groups[0].representativeActionOrdinal).toBe(2);
        expect(validateActionSourceTransactionOutput(inventory, 0, emit(value, [2]))[0].global_sequence).toBe('102');
    });

    it('matches actual Antelope last-receipt counters and notification-chain grouping', () => {
        const value = input([action(1), action(2, 1, 'alice'), action(3, 2, 'bob'), action(4, 0)]);
        const inventory = deriveActionSourceInventory(value), docs = emit(value, [1, 2, 3, 4]);
        expect(inventory.transactions[0].groups.map(value => value.actionOrdinals)).toEqual([[1, 2], [3], [4]]);
        expect(docs[0].code_sequence).toBe(2); expect(docs[0].abi_sequence).toBe(22);
        expect(docs[0].receipts[0].code_sequence).toBeUndefined();
        expect(validateActionSourceTransactionOutput(inventory, 0, docs)).toHaveLength(3);
        docs[0].code_sequence = 1;
        expect(() => validateActionSourceTransactionOutput(inventory, 0, docs)).toThrow('metadata differs');
    });

    it('keeps root global sequence independent of receipt order', () => {
        const value = wireInput('wire-sysio-7dede884-engineering-v1', [action(2, 1, 'alice', '102'), action(1, 0, 'token', '101')]);
        value.wireActionInputs = value.wireActionInputs!.map(fact => ({...fact, inputActionOrdinal: 1}));
        const inventory = deriveActionSourceInventory(value), docs = emit(value, [2, 1]);
        expect(docs[0].global_sequence).toBe('101'); expect(docs[0].receipts[0].global_sequence).toBe('102');
        expect(inventory.transactions[0].groups[0].representativeActionOrdinal).toBe(1);
        expect(validateActionSourceTransactionOutput(inventory, 0, docs)).toHaveLength(1);
    });

    it('separates allowed exception parse counters from committed outputs', () => {
        const failed = action(1); failed[1].except = 'contract failure'; failed[1].receipt = null;
        const value = input([failed, action(2, 0)]), inventory = deriveActionSourceInventory(value);
        expect(inventory.transactions[0].parsedActionCount).toBe(2);
        expect(inventory.transactions[0].groups).toHaveLength(1);
        expect(validateActionSourceTransactionOutput(inventory, 0, emit(value, [1, 2]))).toHaveLength(1);
        const empty = deriveActionSourceInventory(input([failed]));
        expect(empty.transactions[0].disposition).toBe('no-effects');
        expect(empty.transactions[0].parsedActionCount).toBe(1);
        expect(empty.transactions[0].occurrences[0].disposition).toBe('no-effects');
        expect(validateActionSourceTransactionOutput(empty, 0, [])).toEqual([]);
    });

    it('preserves nonce first-action usage reset and single-action inline cleanup', () => {
        const nonce = action(1); nonce[1].act.account = 'eosio.null'; nonce[1].act.name = 'nonce';
        nonce[1].receiver = 'eosio.null'; nonce[1].receipt[1].receiver = 'eosio.null';
        const value = input([nonce, action(2, 0)]), inventory = deriveActionSourceInventory(value), docs = emit(value, [1, 2]);
        expect(docs.map(value => value.cpu_usage_us)).toEqual([15, 15]);
        expect(validateActionSourceTransactionOutput(inventory, 0, docs)).toHaveLength(2);
        value.policy = {...value.policy, maxInline: 1};
        const one = deriveActionSourceInventory(value), oneDoc = emit(value, [1]);
        expect(oneDoc[0].inline_count).toBeUndefined(); expect(oneDoc[0].inline_filtered).toBeUndefined();
        expect(validateActionSourceTransactionOutput(one, 0, oneDoc)).toHaveLength(1);
    });

    for (const profileId of ['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1'] as const) {
        it(`uses complete independent Wire observations for ${profileId}`, () => {
            const value = wireInput(profileId), inventory = deriveActionSourceInventory(value), docs = emit(value, [1, 2]);
            expect(inventory.transactions[0].groups[0].inputActionOrdinal).toBe(1);
            expect(docs[0].code_sequence).toBe(1);
            expect(docs[0].receipts.map((entry: any) => entry.code_sequence)).toEqual([1, 2]);
            expect(validateActionSourceTransactionOutput(inventory, 0, docs)).toHaveLength(1);
            value.policy = {...value.policy, maxInline: 1};
            value.wireActionInputs = value.wireActionInputs!.slice(0, 1);
            expect(() => deriveActionSourceInventory(value)).toThrow('Incomplete Wire source observation');
        });
    }

    it('rejects missing, duplicate, tampered and invented Wire source bindings', () => {
        for (const mutate of [
            (value: any) => {delete value.wireActionInputs;},
            (value: any) => {value.wireActionInputs[1] = value.wireActionInputs[0];},
            (value: any) => {value.wireActionInputs[1].rawHex = 'ffff';},
            (value: any) => {value.wireActionInputs[1].inputActionOrdinal = 2;},
            (value: any) => {value.wireActionInputs[1].actionOrdinal = '2';},
            (value: any) => {value.wireActionInputs[1].extra = true;},
            (value: any) => {delete value.sourceSelectionId;},
            (value: any) => {value.traces[0][1].action_traces[1][1].creator_action_ordinal = 99;},
        ]) {
            const value = wireInput('wire-sysio-7dede884-engineering-v1'); mutate(value);
            expect(() => deriveActionSourceInventory(value)).toThrow(ActionSourceInventoryError);
        }
    });

    it('checks complete Wire creator ancestry even for inline first receivers', () => {
        const second = action(2, 99); second[1].act.data = '0304';
        const value = wireInput('wire-sysio-7dede884-engineering-v1', [action(1), second]);
        expect(() => deriveActionSourceInventory(value)).toThrow('Invalid Wire creator ancestry');
    });

    it('rejects unqualified profiles, parser changes and normalized filter aliases', () => {
        expect(() => deriveActionSourceInventory({...input(), profileId: 'future' as any})).toThrow('Unqualified');
        const value = input();
        value.policy = {...value.policy, parserVersion: '3.3' as any};
        expect(() => deriveActionSourceInventory(value)).toThrow('Unsupported source inventory policy');
        value.policy = {...value.policy, parserVersion: '3.2', actionWhitelist: ['chain::token::transfer']};
        expect(() => deriveActionSourceInventory(value)).toThrow('normalized');
    });

    it('snapshots and normalizes effective policy without retaining caller aliases', () => {
        const value = input(); value.policy = {...value.policy, actionWhitelist: ['token::*', 'token::*']};
        const inventory = deriveActionSourceInventory(value);
        (value.policy.actionWhitelist as string[]).push('other::*');
        (value.traces as any[])[0][1].action_traces[0][1].receipt[1].recv_sequence = '999';
        expect(inventory.policy.actionWhitelist).toEqual(['token::*']);
        expect(Object.isFrozen(inventory.transactions[0].groups[0].metadata)).toBe(true);
        expect(inventory.policySha256).toBe(sha(actionHistoryImmutableJson(inventory.policy)));
    });

    it('bounds source transaction and occurrence counts before deriving groups', () => {
        expect(() => deriveActionSourceInventory({...input(), traces: new Array(100_001).fill(null)})).toThrow('bounded original trace vector');
        const value = input(); (value.traces as any[])[0][1].action_traces = new Array(100_001).fill(null);
        expect(() => deriveActionSourceInventory(value)).toThrow('bounded count');
    });

    it('keeps uint32 counters numeric beyond signed mappings and validates each metadata leaf', () => {
        const value = wireInput('wire-sysio-7dede884-engineering-v1', [action()]);
        const receipt = (value.traces as any[])[0][1].action_traces[0][1].receipt[1];
        receipt.code_sequence = 0xffffffff; receipt.abi_sequence = 0xffffffff;
        value.wireActionInputs = value.wireActionInputs!.map(fact => ({...fact, receiptAbiSequence: '4294967295'}));
        const inventory = deriveActionSourceInventory(value), docs = emit(value, [1]);
        expect(validateActionSourceTransactionOutput(inventory, 0, docs)[0].code_sequence).toBe(0xffffffff);
        docs[0].receipts[0].abi_sequence = '4294967295';
        expect(() => validateActionSourceTransactionOutput(inventory, 0, docs)).toThrow('uint32');
        receipt.code_sequence = 0x100000000;
        expect(() => deriveActionSourceInventory(value)).toThrow('uint32');
    });

    it('rejects repeated source transactions, ordinals, globals and malformed portable input', () => {
        const duplicateTx = input(); (duplicateTx.traces as any[]).push(clone((duplicateTx.traces as any[])[0]));
        const duplicateOrdinal = input([action(1), action(1, 0, 'token', '102')]);
        const duplicateSequence = input([action(1), action(2, 0, 'token', '101')]);
        for (const value of [duplicateTx, duplicateOrdinal, duplicateSequence]) expect(() => deriveActionSourceInventory(value)).toThrow(ActionSourceInventoryError);
        const sparse = input(); (sparse.traces as any[])[2] = transaction([], secondId);
        expect(() => deriveActionSourceInventory(sparse)).toThrow('sparse');
        const accessors = input(); let calls = 0;
        Object.defineProperty(accessors, 'traces', {enumerable: true, get() {calls++; return [];}});
        expect(() => deriveActionSourceInventory(accessors)).toThrow('accessors'); expect(calls).toBe(0);
    });
});

describe('whole final transaction validation', () => {
    it('rejects dropped groups, receipts, empty process fragments and reordered independent actions', () => {
        const value = input([action(1), action(2, 1, 'alice'), action(3, 0)]), inventory = deriveActionSourceInventory(value);
        const docs = emit(value, [1, 2, 3]);
        expect(validateActionSourceTransactionOutput(inventory, 0, docs)).toHaveLength(2);
        for (const batch of [[], docs.slice(1), [...docs].reverse()]) expect(() => validateActionSourceTransactionOutput(inventory, 0, batch)).toThrow(ActionSourceInventoryError);
        const dropped = clone(docs); dropped[0].receipts.pop();
        expect(() => validateActionSourceTransactionOutput(inventory, 0, dropped)).toThrow('metadata differs');
    });

    it('validates root/source/act identities and every receipt/auth association', () => {
        const value = input([action(1), action(2, 1, 'alice')]), inventory = deriveActionSourceInventory(value), docs = emit(value, [1, 2]);
        for (const mutate of [
            (doc: any) => {doc.global_sequence = doc.receipts[1].global_sequence;},
            (doc: any) => {doc.block_id = '0'.repeat(64);},
            (doc: any) => {doc.trx_id = secondId;},
            (doc: any) => {doc.block_num++;},
            (doc: any) => {doc.producer = 'wrong';},
            (doc: any) => {doc['@timestamp'] = 'wrong';},
            (doc: any) => {doc.action_ordinal++;},
            (doc: any) => {doc.act.authorization[0].actor = 'bob';},
            (doc: any) => {doc.receipts.reverse();},
            (doc: any) => {doc.receipts[0].receiver = 'bob';},
            (doc: any) => {doc.receipts[0].recv_sequence = '999';},
            (doc: any) => {doc.receipts[0].auth_sequence[0].account = 'bob';},
            (doc: any) => {doc.receipts[0].auth_sequence[0].sequence = '999';},
            (doc: any) => {doc.receipts[0].auth_sequence[0].sequence = 11;},
            (doc: any) => {doc.receipts[0].code_sequence = 1;},
            (doc: any) => {doc.receipt = {};},
            (doc: any) => {doc.inline_count = 999;},
        ]) {
            const changed = clone(docs); mutate(changed[0]);
            expect(() => validateActionSourceTransactionOutput(inventory, 0, changed)).toThrow(ActionSourceInventoryError);
        }
    });

    it('requires current certified Wire grouping and source bindings, not raw fallback', () => {
        const value = wireInput('wire-sysio-7dede884-engineering-v1'), inventory = deriveActionSourceInventory(value), docs = emit(value, [1, 2]);
        for (const mutate of [
            (doc: any) => {doc.protocol.status = 'incomplete';},
            (doc: any) => {doc.protocol.input.inputActionOrdinal = 2;},
            (doc: any) => {doc.protocol.source.blockId = '0'.repeat(64);},
            (doc: any) => {doc.protocol.selectionId = 'h45srcsel1:' + '0'.repeat(64);},
            (doc: any) => {doc.receipts[0].code_sequence++;},
        ]) {
            const changed = clone(docs); mutate(changed[0]);
            expect(() => validateActionSourceTransactionOutput(inventory, 0, changed)).toThrow('metadata differs');
        }
        const rawFallback = clone(docs); rawFallback[0].ds_error = true;
        expect(() => validateActionSourceTransactionOutput(inventory, 0, rawFallback)).toThrow('Incomplete Wire decoding');
    });

    it('rejects deserialized expectations and re-issues only by deriving from original retained input', () => {
        const value = input(), inventory = deriveActionSourceInventory(value), docs = emit(value, [1]);
        const serialized = JSON.parse(JSON.stringify(inventory));
        expect(() => validateActionSourceTransactionOutput(serialized, 0, docs)).toThrow('re-derived');
        const reopened = deriveActionSourceInventory(JSON.parse(JSON.stringify(value)));
        expect(reopened).toEqual(inventory);
        expect(validateActionSourceTransactionOutput(reopened, 0, docs)).toHaveLength(1);
        expect(() => validateActionSourceTransactionOutput(inventory, 99, [])).toThrow('Incomplete');
    });

    it('detaches opaque finite contract values and refuses malformed output before publication', () => {
        const value = input(), inventory = deriveActionSourceInventory(value), docs = emit(value, [1]);
        docs[0].act.data = {decimal: 1.25, arbitrarySafePolicyName: 9007199254740992, receipts: [{sequence: 1.5}]};
        const detached = validateActionSourceTransactionOutput(inventory, 0, docs);
        docs[0].act.data.decimal = 2.5;
        expect((detached[0].act as any).data.decimal).toBe(1.25);
        expect(Object.isFrozen((detached[0].act as any).data)).toBe(true);
        docs[0].act.data = {bad: Infinity};
        expect(() => validateActionSourceTransactionOutput(inventory, 0, docs)).toThrow(ActionSourceInventoryError);
    });

    it('retains exact strings at 2^53, 2^63 and uint64 maximum without interpreting contract fields', () => {
        for (const sequence of ['9007199254740992', '9223372036854775808', '18446744073709551615']) {
            const value = input([action(1, 0, 'token', sequence)]);
            const receipt = (value.traces as any[])[0][1].action_traces[0][1].receipt[1];
            receipt.recv_sequence = sequence; receipt.auth_sequence[0].sequence = sequence;
            const inventory = deriveActionSourceInventory(value), docs = emit(value, [1]);
            expect(validateActionSourceTransactionOutput(inventory, 0, docs)[0].global_sequence).toBe(sequence);
            docs[0].global_sequence = Number(sequence);
            expect(() => validateActionSourceTransactionOutput(inventory, 0, docs)).toThrow(ActionSourceInventoryError);
        }
    });
});
