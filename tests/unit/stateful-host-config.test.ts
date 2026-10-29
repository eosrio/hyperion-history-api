import {expect, test} from 'bun:test';
import {resolveStatefulOwnerConfigurationV2} from '../../src/indexer/projection/stateful-config.js';

const configured = () => ({interfaceVersion: 2, sourceInputVersion: 2,
    backend: {kind: 'mongodb', id: 'chain-state', database: 'chain_state'}, recovery: {bytes: 64 * 1024 * 1024},
    api: {timeoutMs: 1000, maximumPendingProbes: 8}});
test('stateful owner remains opt-in and requires explicit request/recovery budgets', () => {
    expect(resolveStatefulOwnerConfigurationV2(undefined)).toBeUndefined();
    const input = configured(), resolved = resolveStatefulOwnerConfigurationV2(input)!;
    expect(resolved.backend).toEqual(input.backend); expect(resolved.recovery.bytes).toBe(input.recovery.bytes);
    expect(Object.isFrozen(resolved)).toBe(true); expect(Object.isFrozen(resolved.api)).toBe(true);
    for (const changed of [{...input, interfaceVersion: 1}, {...input, sourceInputVersion: 1}, {...input, api: {}},
        {...input, recovery: {}}, {...input, api: {timeoutMs: '5s', maximumPendingProbes: 8}}])
        expect(() => resolveStatefulOwnerConfigurationV2(changed)).toThrow();
});
test('v2 cannot select another backend for projections on the same chain', () => {
    const input = configured();
    expect(resolveStatefulOwnerConfigurationV2(input, {backend: input.backend as any, projections: []})).toBeDefined();
    for (const backend of [{...input.backend, id: 'other'}, {...input.backend, database: 'other'}, {...input.backend, kind: 'wormdb'}])
        expect(() => resolveStatefulOwnerConfigurationV2(input, {backend: backend as any, projections: []})).toThrow('per-chain backend');
});
test('invalid probe/native bounds and accessor configuration fail before resource admission', () => {
    const input = configured();
    for (const changed of [{...input, api: {...input.api, maximumPendingProbes: 4097}}, {...input, api: {...input.api, maximumPendingProbes: 0}},
        {...input, operationTimeoutMS: 30001}, {...input, transactionTimeoutMS: 60001}, {...input, maximumFramesPerDrain: 33},
        {...input, recovery: {bytes: 1000, maxBlockBytes: 1001}}]) expect(() => resolveStatefulOwnerConfigurationV2(changed)).toThrow();
    let evaluated = 0;
    expect(() => resolveStatefulOwnerConfigurationV2({...input, get generation() {evaluated++; return 'untrusted';}})).toThrow();
    expect(evaluated).toBe(0);
});
