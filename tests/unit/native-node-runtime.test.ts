import {expect, test} from 'bun:test';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';

test('qualification accepts the selected native runtimes and refuses retired, unselected and Bun hosts', () => {
    for (const [node, major] of [['24.19.0', 24], ['26.12.1', 26]] as const)
        expect(assertNativeQualificationRuntime({release: {name: 'node'}, versions: {node}})).toBe(major);
    for (const node of ['20.20.0', '22.23.3', '25.0.0', '27.0.0', 'unknown'])
        expect(() => assertNativeQualificationRuntime({release: {name: 'node'}, versions: {node}})).toThrow('native Node.js 24 or 26');
    expect(() => assertNativeQualificationRuntime({release: {name: 'node'}, versions: {node: '24.0.0', bun: '1.4.4'}})).toThrow();
    expect(() => assertNativeQualificationRuntime({release: {name: 'other'}, versions: {node: '26.12.1'}})).toThrow();
});
