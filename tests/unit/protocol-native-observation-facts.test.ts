import {describe, expect, it} from 'bun:test';
import {createHash} from 'node:crypto';
import type {ProtocolAbiActionInput} from '@eosrio/hyperion-sdk/protocol';
import {protocolNativeInputInventory, snapshotProtocolNativeDecisions} from '../../src/indexer/protocol/native-observation-facts.js';

const txid = 'a'.repeat(64), digest = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
function inputs(): ProtocolAbiActionInput[] {
    const root = {transactionId: txid, actionOrdinal: 1, inputActionOrdinal: 1, receiver: 'token', account: 'token',
        name: 'transfer', rawHex: '0102', globalSequence: '9007199254740993', receiptAbiSequence: '3'};
    return [root, {...root, actionOrdinal: 3, inputActionOrdinal: 3, rawHex: '0304', globalSequence: '9007199254740994'},
        {...root, actionOrdinal: 2, receiver: 'alice', globalSequence: '9007199254740995'}];
}
const origin = (row: ProtocolAbiActionInput) => ({transactionId: row.transactionId,
    actionOrdinal: row.actionOrdinal, rawSha256: digest(row.rawHex)});
function facts(rows = inputs()): any {
    return {schemaVersion: 1, decisions: [
        {origin: origin(rows[1]!), kind: 'incomplete', error: {code: 'unsupported', message: 'Only this origin is unsupported'}},
        {origin: origin(rows[0]!), kind: 'native', nativeKind: 'fixture.native.v1'},
    ]};
}

describe('native decisions bound to independent original input membership', () => {
    it('refuses omitted, empty, invented and mismatched first-receiver decisions', () => {
        const rows = inputs();
        const omitted = facts(); omitted.decisions.pop();
        const empty = {schemaVersion: 1, decisions: []};
        const invented = facts(); invented.decisions[0].origin.actionOrdinal = 999;
        const notification = facts(); notification.decisions[0].origin = origin(rows[2]!);
        const wrongBytes = facts(); wrongBytes.decisions[0].origin.rawSha256 = '0'.repeat(64);
        for (const candidate of [omitted, empty, invented, notification, wrongBytes]) {
            expect(() => snapshotProtocolNativeDecisions(candidate, rows)).toThrow();
        }
    });

    it('normalizes labels to retained vector order while preserving per-origin incompleteness', () => {
        const candidate = facts(), checked = snapshotProtocolNativeDecisions(candidate, inputs());
        expect(checked.decisions.map(decision => decision.origin.actionOrdinal)).toEqual([1, 3]);
        expect(checked.decisions.map(decision => decision.kind)).toEqual(['native', 'incomplete']);
        expect(Object.isFrozen(checked)).toBe(true);
        expect(Object.isFrozen(checked.decisions)).toBe(true);
        expect(checked.decisions.every(Object.isFrozen)).toBe(true);
        candidate.decisions[1].nativeKind = 'changed';
        expect(checked.decisions[0]).toHaveProperty('nativeKind', 'fixture.native.v1');
    });

    it('binds the full input vector, including notification receipts and its original order', () => {
        const rows = inputs(), summary = protocolNativeInputInventory(rows);
        expect(summary).toMatchObject({schemaVersion: 1, inputCount: 3, firstReceiverCount: 2});
        expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(protocolNativeInputInventory(structuredClone(rows))).toEqual(summary);
        const changed = structuredClone(rows); changed[2] = {...changed[2]!, globalSequence: '18446744073709551615'};
        expect(protocolNativeInputInventory(changed).sha256).not.toBe(summary.sha256);
        expect(protocolNativeInputInventory([rows[1]!, rows[0]!, rows[2]!]).sha256).not.toBe(summary.sha256);
        expect(Object.isFrozen(summary)).toBe(true);
    });

    it('permits complete encoded-empty membership and refuses malformed labels or original rows', () => {
        expect(snapshotProtocolNativeDecisions({schemaVersion: 1, decisions: []}, [])).toEqual({schemaVersion: 1, decisions: []});
        expect(protocolNativeInputInventory([])).toMatchObject({inputCount: 0, firstReceiverCount: 0});
        const duplicate = facts(); duplicate.decisions[1] = duplicate.decisions[0];
        expect(() => snapshotProtocolNativeDecisions(duplicate, inputs())).toThrow();
        expect(() => protocolNativeInputInventory([inputs()[0]!, inputs()[0]!])).toThrow();
        let getters = 0;
        const candidate = Object.defineProperty({schemaVersion: 1}, 'decisions', {enumerable: true,
            get() {getters++; return [];}});
        expect(() => snapshotProtocolNativeDecisions(candidate, [])).toThrow();
        expect(getters).toBe(0);
    });
});
