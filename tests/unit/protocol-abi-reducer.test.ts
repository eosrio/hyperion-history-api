import {describe, expect, it} from 'bun:test';
import type {ProtocolAbiActionInput, ProtocolBlockAbiObservations} from '@eosrio/hyperion-sdk/protocol';
import {reduceProtocolAbiBlock, type ProtocolAbiAccountState, type ProtocolAbiBlockReduction} from '../../src/indexer/protocol/abi-reducer.js';
import {protocolAbiCaptureDigest, protocolAbiObservationId, type ProtocolAbiObservationRecord} from '../../src/indexer/protocol/abi-observation-store.js';

const transactionId = '4'.repeat(64), parentBlockId = '3'.repeat(64);
const profile = () => ({id: '@eosrio/hyperion-wire-plugin', profileId: 'wire-sysio-6508c9e8', components: [
    {id: 'wire-rust', runtime: 'rust' as const, version: '0.0.0-dev.1', sourceRevision: 'a'.repeat(40), sha256: 'b'.repeat(64)},
    {id: 'wire-node', runtime: 'node' as const, version: '0.0.0-dev.1', sourceRevision: 'c'.repeat(40), sha256: 'd'.repeat(64)},
]});
const facts = (): ProtocolBlockAbiObservations => ({schemaVersion: 1, actionInputs: [], deployments: [], finalStates: []});
const action = (ordinal: number, globalSequence: string, account = 'alice', overrides: Partial<ProtocolAbiActionInput> = {}): ProtocolAbiActionInput =>
    ({transactionId, actionOrdinal: ordinal, inputActionOrdinal: ordinal, receiver: account, account, name: 'run', rawHex: '07000000',
        globalSequence, receiptAbiSequence: '1', ...overrides});
const publication = (input: ProtocolAbiActionInput, account: string, abiHex: string): ProtocolBlockAbiObservations['deployments'][number] =>
    ({account, abiHex, action: {transactionId: input.transactionId, actionOrdinal: input.actionOrdinal},
        globalSequence: input.globalSequence, effect: 'native-before-receipt'});
const final = (account: string, abiHex: string, deltaOrdinal = 0, present = true): ProtocolBlockAbiObservations['finalStates'][number] =>
    ({account, abiHex, deltaOrdinal, present});
const seal = (record: ProtocolAbiObservationRecord): ProtocolAbiObservationRecord => {
    const {inputSha256, ...source} = record.source;
    record.source.inputSha256 = protocolAbiCaptureDigest(source, record.capture);return record;
};
const record = (value = facts()): ProtocolAbiObservationRecord => seal({schemaVersion: 1, protocol: profile(),
    source: {chainId: '1'.repeat(64), blockNum: 10, blockId: '2'.repeat(64), previousBlockId: parentBlockId, inputSha256: ''},
    capture: {kind: 'unattested-ship-result-sections-v1', schemaJson: '{}', blockHex: '00', tracesHex: '00', deltasHex: '00'},
    observation: {status: 'observed', facts: value}});
const priorState = (account: string, abiHex: string, present = true): ProtocolAbiAccountState => ({account, abiHex, present, protocol: profile(),
    source: {observationId: 'h45abi1:' + '5'.repeat(64), chainId: '1'.repeat(64), blockNum: 9, blockId: parentBlockId,
        inputSha256: '6'.repeat(64), phase: 'block-end', deltaOrdinal: 0}});
const complete = (result: ProtocolAbiBlockReduction): Extract<ProtocolAbiBlockReduction, {status: 'complete'}> => {
    if (result.status !== 'complete') throw new Error(`${result.reason.code}: ${result.reason.message}`);
    expect(result.status).toBe('complete');return result;
};
const reset = (result: ProtocolAbiBlockReduction, code?: string): void => {
    expect(result.status).toBe('incomplete');expect(result.reset).toBe(true);
    expect(result.bindings).toEqual([]);expect(result.updates).toEqual([]);expect(result.lastGlobalSequence).toBeNull();
    if (result.status === 'incomplete' && code) expect(result.reason.code).toBe(code);
};

describe('canonical block ABI occurrence reduction', () => {
    it('keeps unknown inputs unknown, without treating an absent delta row as account absence', async () => {
        const input = facts();input.actionInputs = [action(1, '10'), action(2, '11')];let resolutions = 0;
        const result = complete(await reduceProtocolAbiBlock(record(input), async () => {resolutions++;return null;}));
        expect(result.bindings.map(binding => binding.state)).toEqual([null, null]);
        expect(result.updates).toEqual([]);expect(result.lastGlobalSequence).toBe('11');expect(resolutions).toBe(1);
    });

    it('binds self-setabi and its notification copies before the native effect, despite the new receipt ABI sequence', async () => {
        const original = action(1, '10', 'sysio', {name: 'setabi', receiptAbiSequence: '43'});
        const notification = {...original, actionOrdinal: 2, receiver: 'observer', globalSequence: '11'};
        const secondNotification = {...original, actionOrdinal: 3, receiver: 'another', globalSequence: '12'};
        const later = action(4, '13', 'sysio', {receiptAbiSequence: '43'});
        const input = facts();input.actionInputs = [later, secondNotification, original, notification];
        input.deployments = [publication(original, 'sysio', 'ffff')];input.finalStates = [final('sysio', 'ffff')];
        const before = priorState('sysio', '0102');
        const result = complete(await reduceProtocolAbiBlock(record(input), async () => before, '9'));
        expect(result.bindings.map(binding => binding.actionOrdinal)).toEqual([1, 2, 3, 4]);
        expect(result.bindings.map(binding => binding.state?.abiHex)).toEqual(['0102', '0102', '0102', 'ffff']);
        expect(result.bindings[1].state).toBe(result.bindings[0].state);expect(result.bindings[2].state).toBe(result.bindings[0].state);
        expect(result.bindings[3].state).toBe(result.updates[0].state);
        expect(result.updates[0].state.source).toMatchObject({phase: 'native-effect', action: {transactionId, actionOrdinal: 1, globalSequence: '10'}});
        expect(result.updates[0].state.source.observationId).toBe(protocolAbiObservationId(record(input)));
    });

    it('orders inline publication ordinal 3 before later top-level ordinal 2 by lossless receipt sequence', async () => {
        const first = action(1, '9007199254740993'), later = action(2, '9007199254740995');
        const inline = action(3, '9007199254740994', 'sysio', {name: 'setabi', receiptAbiSequence: '0'});
        const input = facts();input.actionInputs = [later, first, inline];input.deployments = [publication(inline, 'alice', 'aabb')];
        input.finalStates = [final('alice', 'aabb')];
        const result = complete(await reduceProtocolAbiBlock(record(input), async account => priorState(account, '0011'), '9007199254740992'));
        expect(result.bindings.map(binding => binding.actionOrdinal)).toEqual([1, 3, 2]);
        expect(result.bindings.map(binding => binding.state?.abiHex)).toEqual(['0011', '0011', 'aabb']);
        expect(result.lastGlobalSequence).toBe('9007199254740995');
        expect(result.updates[0].account).toBe('alice');
    });

    it('uses provider publication targets rather than the system action receipt ABI sequence', async () => {
        const deploy = action(1, '10', 'sysio', {name: 'setabi', receiptAbiSequence: '999'});
        const input = facts();input.actionInputs = [deploy, action(2, '11', 'alice'), action(3, '12', 'sysio')];
        input.deployments = [publication(deploy, 'alice', 'abcd')];input.finalStates = [final('alice', 'abcd')];
        const result = complete(await reduceProtocolAbiBlock(record(input), async account => priorState(account, account === 'sysio' ? '01' : '02')));
        expect(result.bindings.map(binding => binding.state?.abiHex)).toEqual(['01', 'abcd', '01']);
        expect(result.updates.map(update => update.account)).toEqual(['alice']);
    });

    it('retains repeated, cleared and malformed ABI publications as barriers without parsing or falling back', async () => {
        const inputs = [action(1, '10', 'sysio'), action(2, '11', 'alice'), action(3, '12', 'sysio'),
            action(4, '13', 'alice'), action(5, '14', 'sysio'), action(6, '15', 'alice')];
        const input = facts();input.actionInputs = inputs;
        input.deployments = [publication(inputs[0], 'alice', '0001'), publication(inputs[2], 'alice', ''), publication(inputs[4], 'alice', 'ff')];
        input.finalStates = [final('alice', 'ff')];
        const result = complete(await reduceProtocolAbiBlock(record(input), async account => priorState(account, '0001')));
        expect(result.bindings.filter(binding => binding.account === 'alice').map(binding => binding.state?.abiHex)).toEqual(['0001', '', 'ff']);
        expect(result.bindings[1].state!.source).toMatchObject({phase: 'native-effect', action: {actionOrdinal: 1}});
        expect(result.bindings[3].state!.present).toBe(true);expect(result.updates[0].state.abiHex).toBe('ff');
    });

    it('seeds final rows after the block without retroactively binding earlier inputs or inferring other accounts', async () => {
        const input = facts();input.actionInputs = [action(1, '10')];input.finalStates = [final('alice', 'ff', 7)];
        const result = complete(await reduceProtocolAbiBlock(record(input), async () => null));
        expect(result.bindings[0].state).toBeNull();expect(result.updates.map(update => update.account)).toEqual(['alice']);
        expect(result.updates[0].state).toMatchObject({present: true, abiHex: 'ff', source: {phase: 'block-end', deltaOrdinal: 7, blockNum: 10}});
    });

    it('preserves known deleted state and its raw provenance as an authoritative barrier', async () => {
        const input = facts();input.actionInputs = [action(1, '10')];input.finalStates = [final('alice', 'beef', 8, false)];
        const result = complete(await reduceProtocolAbiBlock(record(input), async () => priorState('alice', 'abcd', false)));
        expect(result.bindings[0].state).toMatchObject({present: false, abiHex: 'abcd'});
        expect(result.updates[0].state).toMatchObject({present: false, abiHex: 'beef', source: {phase: 'block-end'}});
    });

    it('resets the entire carried applicability result if any native target lacks its matching final barrier', async () => {
        for (const end of [[], [final('alice', 'aa')], [final('alice', 'bb', 0, false)]]) {
            const deploy = action(1, '10', 'sysio');const input = facts();input.actionInputs = [deploy, action(2, '11', 'unrelated')];
            input.deployments = [publication(deploy, 'alice', 'bb')];input.finalStates = end;
            reset(await reduceProtocolAbiBlock(record(input), async account => priorState(account, '01')), 'protocol_abi_final_state_mismatch');
        }
    });

    it('reconciles multiple publications against the last bytes, including an empty final ABI', async () => {
        const first = action(1, '10', 'sysio'), last = action(2, '11', 'sysio');const input = facts();
        input.actionInputs = [first, last];input.deployments = [publication(last, 'alice', ''), publication(first, 'alice', 'ff')];
        input.finalStates = [final('alice', '')];
        const result = complete(await reduceProtocolAbiBlock(record(input), async () => null));
        expect(result.updates[0].state).toMatchObject({present: true, abiHex: '', source: {phase: 'native-effect', action: {actionOrdinal: 2}}});
    });

    it('detects unobserved changes from known state while permitting a new unknown post-block seed', async () => {
        const input = facts();input.finalStates = [final('alice', 'bb')];
        reset(await reduceProtocolAbiBlock(record(input), async () => priorState('alice', 'aa')), 'protocol_abi_final_state_mismatch');
        reset(await reduceProtocolAbiBlock(record(input), async () => priorState('alice', '', false)), 'protocol_abi_final_state_mismatch');
        expect(complete(await reduceProtocolAbiBlock(record(input), async () => null)).updates[0].state.abiHex).toBe('bb');
        input.finalStates = [final('alice', '')];
        expect(complete(await reduceProtocolAbiBlock(record(input), async () => priorState('alice', '', false))).updates[0].state.present).toBe(true);
    });

    it('retains the receipt fence across empty complete blocks and rejects regressions and invalid lossless fences', async () => {
        expect(complete(await reduceProtocolAbiBlock(record(), async () => null, '18446744073709551615')).lastGlobalSequence).toBe('18446744073709551615');
        expect(complete(await reduceProtocolAbiBlock(record(), async () => null)).lastGlobalSequence).toBeNull();
        const input = facts();input.actionInputs = [action(1, '9007199254740993')];
        for (const fence of ['9007199254740993', '9007199254740994'])
            reset(await reduceProtocolAbiBlock(record(input), async () => null, fence), 'protocol_abi_sequence_regression');
        for (const fence of ['01', '-1', '18446744073709551616', 10])
            reset(await reduceProtocolAbiBlock(record(), async () => null, fence as string));
        expect(complete(await reduceProtocolAbiBlock(record(input), async () => null, '0')).lastGlobalSequence).toBe('9007199254740993');
    });

    it('resets explicit incomplete records before resolving any carried state', async () => {
        const input = record();input.observation = {status: 'incomplete', error: {code: 'missing_traces', message: 'Raw traces unavailable'}};
        reset(await reduceProtocolAbiBlock(input, async () => {throw new Error('Must not resolve');}), 'protocol_abi_observation_incomplete');
        for (const key of ['schemaJson', 'tracesHex', 'deltasHex'] as const) {
            const missing = record();missing.capture[key] = null;seal(missing);
            reset(await reduceProtocolAbiBlock(missing, async () => {throw new Error('Must not resolve');}));
        }
    });

    it('rejects forged graphs, duplicate anchors/sequences, invalid ordinals, publication anchors and final barriers', async () => {
        const mutator = action(1, '10', 'sysio'), ordinary = action(2, '11', 'alice');
        const base = facts();base.actionInputs = [mutator, ordinary];base.deployments = [publication(mutator, 'alice', 'ff')];base.finalStates = [final('alice', 'ff')];
        const changes: Array<(value: any) => void> = [
            value => value.actionInputs.push({...value.actionInputs[0]}),
            value => {value.actionInputs[1].globalSequence = '10';},
            value => {value.actionInputs[0].actionOrdinal = 0;},
            value => {value.actionInputs[0].inputActionOrdinal = 0x100000000;},
            value => {value.actionInputs[1].inputActionOrdinal = 1;},
            value => {value.actionInputs[1].receiver = 'observer';value.actionInputs[1].inputActionOrdinal = 1;},
            value => {value.actionInputs[1].receiver = 'observer';},
            value => value.deployments.push({...value.deployments[0]}),
            value => {value.deployments[0].action.transactionId = 'e'.repeat(64);},
            value => {value.deployments[0].globalSequence = '11';},
            value => {value.deployments[0].action.actionOrdinal = 2;},
            value => value.finalStates.push({...value.finalStates[0], deltaOrdinal: 1}),
            value => value.finalStates.push({...value.finalStates[0], account: 'bob'}),
            value => {value.finalStates[0].deltaOrdinal = 0x100000000;},
        ];
        for (const change of changes) {
            const forged = structuredClone(base);change(forged);
            reset(await reduceProtocolAbiBlock(record(forged), async account => priorState(account, '01')));
        }
    });

    it('requires notifications to copy the exact original input within the same transaction', async () => {
        const original = action(1, '10'), notification = {...original, actionOrdinal: 2, receiver: 'observer', globalSequence: '11'};
        for (const changes of [{account: 'bob'}, {name: 'other'}, {rawHex: '08000000'}, {transactionId: 'e'.repeat(64)}, {globalSequence: '9'}]) {
            const input = facts();input.actionInputs = [original, {...notification, ...changes}];
            reset(await reduceProtocolAbiBlock(record(input), async () => null));
        }
        const input = facts();input.actionInputs = [original, notification];input.deployments = [publication(notification, 'alice', 'ff')];input.finalStates = [final('alice', 'ff')];
        reset(await reduceProtocolAbiBlock(record(input), async () => null));
    });

    it('rejects future, foreign-profile and immediate-parent fork account provenance', async () => {
        const input = facts();input.actionInputs = [action(1, '10')];
        const changes: Array<(value: any) => void> = [
            value => {value.account = 'bob';}, value => {value.source.chainId = '7'.repeat(64);},
            value => {value.source.blockNum = 10;}, value => {value.source.blockId = '8'.repeat(64);},
            value => {value.protocol.profileId = 'different';}, value => {value.protocol.components[0].sha256 = '8'.repeat(64);},
            value => {value.source.observationId = 'h45abi1:bad';}, value => {value.source.deltaOrdinal = -1;},
        ];
        for (const change of changes) {
            const supplied = priorState('alice', 'ff');change(supplied);
            reset(await reduceProtocolAbiBlock(record(input), async () => supplied), 'protocol_abi_invalid_account_state');
        }
        const native: any = priorState('alice', 'ff');native.source = {...native.source, phase: 'native-effect', action: {transactionId, actionOrdinal: 1, globalSequence: '10'}};
        delete native.source.deltaOrdinal;
        reset(await reduceProtocolAbiBlock(record(input), async () => native, '9'), 'protocol_abi_invalid_account_state');
        native.source.action.globalSequence = '9';native.present = false;
        reset(await reduceProtocolAbiBlock(record(input), async () => native, '9'), 'protocol_abi_invalid_account_state');
    });

    it('does not downgrade resolver infrastructure exceptions to incomplete source evidence', async () => {
        const input = facts();input.actionInputs = [action(1, '10')];const unavailable = new Error('ES realtime GET unavailable');
        await expect(reduceProtocolAbiBlock(record(input), async () => {throw unavailable;})).rejects.toBe(unavailable);
        const finalOnly = facts();finalOnly.finalStates = [final('alice', 'ff')];
        await expect(reduceProtocolAbiBlock(record(finalOnly), async () => {throw unavailable;})).rejects.toBe(unavailable);
        reset(await reduceProtocolAbiBlock(record(input), async () => undefined as any), 'protocol_abi_invalid_account_state');
    });

    it('detaches state and source facts before async work, and reuses immutable binding state references', async () => {
        const input = facts();input.actionInputs = [action(1, '10'), action(2, '11')];const source = record(input), supplied: any = priorState('alice', 'ff');
        let release!: (value: ProtocolAbiAccountState) => void;
        const resultPromise = reduceProtocolAbiBlock(source, () => new Promise(resolve => {release = resolve;}));
        (input.actionInputs[0] as any).name = 'changed';(source.protocol as any).profileId = 'changed';source.source.blockId = '9'.repeat(64);
        release(supplied);const result = complete(await resultPromise);
        expect(result.bindings[0].name).toBe('run');expect(result.bindings[0].state).toBe(result.bindings[1].state);
        supplied.abiHex = '00';supplied.source.blockId = '9'.repeat(64);supplied.protocol.components[0].sha256 = '9'.repeat(64);
        expect(result.bindings[0].state).toMatchObject({abiHex: 'ff', source: {blockId: parentBlockId}, protocol: {profileId: 'wire-sysio-6508c9e8'}});
        expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.bindings[0])).toBe(true);
        expect(Object.isFrozen(result.bindings[0].state)).toBe(true);expect(Object.isFrozen(result.bindings[0].state!.source)).toBe(true);
        expect(Object.isFrozen(result.bindings[0].state!.protocol.components)).toBe(true);
    });

    it('handles exact account identifiers with Map semantics and preserves stable raw component ordering', async () => {
        const input = facts();input.actionInputs = [action(1, '10', '__proto__'), action(2, '11', 'constructor')];
        input.finalStates = [final('constructor', 'cc', 1), final('__proto__', 'bb', 0)];
        const result = complete(await reduceProtocolAbiBlock(record(input), async () => null));
        expect(result.bindings.map(binding => binding.state)).toEqual([null, null]);
        expect(result.updates.map(update => update.account)).toEqual(['__proto__', 'constructor']);
        expect(result.updates[0].state.protocol.components.map(component => component.runtime)).toEqual(['node', 'rust']);
    });

    it('bounds distinct resolved prior states at 64MiB while counting repeated inputs only once', async () => {
        const maximumBytes = 64 * 1024 * 1024;
        const alice = priorState('alice', ''), bobby = priorState('bobby', '');
        // These ASCII fixtures have the same canonical JSON byte length as an
        // ordinary JSON representation; key order cannot change their size.
        const remaining = maximumBytes - Buffer.byteLength(JSON.stringify(alice)) - Buffer.byteLength(JSON.stringify(bobby));
        const firstHexCharacters = Math.floor(remaining / 4) * 2;
        (alice as any).abiHex = 'aa'.repeat(firstHexCharacters / 2);
        (bobby as any).abiHex = 'bb'.repeat((remaining - firstHexCharacters) / 2);
        expect(Buffer.byteLength(JSON.stringify(alice)) + Buffer.byteLength(JSON.stringify(bobby))).toBe(maximumBytes);
        const input = facts();input.actionInputs = Array.from({length: 12}, (_, index) => action(index + 1, String(index + 10), index % 2 ? 'bobby' : 'alice'));
        const calls: string[] = [];
        const resolver = async (account: string) => {calls.push(account);return account === 'alice' ? alice : bobby;};
        const result = complete(await reduceProtocolAbiBlock(record(input), resolver));
        expect(calls).toEqual(['alice', 'bobby']);expect(result.bindings).toHaveLength(12);
        expect(result.bindings[0].state).toBe(result.bindings[10].state);expect(result.bindings[1].state).toBe(result.bindings[11].state);
        (bobby as any).abiHex += 'ff';calls.length = 0;
        reset(await reduceProtocolAbiBlock(record(input), resolver), 'protocol_abi_account_budget');
        expect(calls).toEqual(['alice', 'bobby']);
    });

    it('rejects mutated capture identities and nonportable provider state without executing getters', async () => {
        const source = record();source.capture.tracesHex = '01';
        reset(await reduceProtocolAbiBlock(source, async () => null), 'protocol_abi_invalid_record');
        const input = facts();input.actionInputs = [action(1, '10')];let getters = 0;
        const supplied: any = priorState('alice', 'ff');Object.defineProperty(supplied, 'abiHex', {enumerable: true, get() {getters++;return 'ff';}});
        reset(await reduceProtocolAbiBlock(record(input), async () => supplied), 'protocol_abi_invalid_account_state');expect(getters).toBe(0);
        const sparse = facts();sparse.actionInputs = new Array(1);
        reset(await reduceProtocolAbiBlock(record(sparse), async () => null), 'protocol_abi_invalid_record');
    });
});
