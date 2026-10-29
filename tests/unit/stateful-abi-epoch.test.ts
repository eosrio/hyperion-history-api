import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {statefulAbiEpoch} from '../../src/indexer/projection/stateful-abi-epoch.js';
import type {ProtocolAbiAccountState} from '../../src/indexer/protocol/abi-reducer.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type NativeState = ProtocolAbiAccountState & {source: Extract<ProtocolAbiAccountState['source'], {phase: 'native-effect'}>};
const original = (sequence: string, ordinal: number): NativeState => ({
    account: 'contract', present: true, abiHex: '0001',
    protocol: {id: 'constructed-unit-profile', profileId: 'constructed-unit-profile', components: []},
    source: {chainId: hash('chain'), blockNum: 10, blockId: hash('block'),
        observationId: 'h45abi1:' + hash('original-observation'), inputSha256: hash('original-input'),
        phase: 'native-effect', action: {transactionId: hash('transaction'), actionOrdinal: ordinal, globalSequence: sequence}},
});

test('constructed identical-byte intra-block redeployments retain exact original occurrence epochs', () => {
    const first = original('9007199254740992', 1), second = original('9007199254740993', 2);
    const a = statefulAbiEpoch(first), b = statefulAbiEpoch(second);
    expect(a.abiSha256).toBe(b.abiSha256); expect(a.id).not.toBe(b.id);
    expect(statefulAbiEpoch(structuredClone(first))).toEqual(a);
    expect(statefulAbiEpoch({...first, source: {...first.source,
        phase: 'native-effect', action: {...first.source.action, globalSequence: '9007199254740993'}}}).id).not.toBe(a.id);
    expect(Object.isFrozen(a)).toBe(true);
});

test('block-end rows and native effect epochs remain distinct at equal block/account/ABI bytes', () => {
    const action = original('1', 1), {action: _action, ...anchor} = action.source;
    const row: ProtocolAbiAccountState = {...action, source: {...anchor, phase: 'block-end', deltaOrdinal: 0}};
    expect(statefulAbiEpoch(action).id).not.toBe(statefulAbiEpoch(row).id);
    expect(statefulAbiEpoch({...row, source: {...row.source, phase: 'block-end', deltaOrdinal: 1}}).id)
        .not.toBe(statefulAbiEpoch(row).id);
});

test('missing/empty ABI barriers cannot become stateful deployment references', () => {
    expect(() => statefulAbiEpoch({...original('1', 1), present: false})).toThrow();
    expect(() => statefulAbiEpoch({...original('1', 1), abiHex: ''})).toThrow();
});
