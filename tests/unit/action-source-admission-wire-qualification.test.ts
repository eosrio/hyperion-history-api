import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {assertWireCapture, validateWireAdmissionArguments, wireAdmissionNames} from '../../scripts/qualification/check-action-source-admission-wire.mjs';

test('native Wire qualification uses deterministic disjoint owned runtime namespaces', () => {
    const run = '0123456789ab';
    expect(wireAdmissionNames(run, 24).map(value => value.chain)).toEqual([
        'hyp-wire-admit-0123456789ab-n24-6508', 'hyp-wire-admit-0123456789ab-n24-7d', 'hyp-wire-admit-0123456789ab-n24-captured7d']);
    const node22 = new Set(wireAdmissionNames(run, 22).map(value => value.chain));
    expect(wireAdmissionNames(run, 24).every(value => !node22.has(value.chain))).toBe(true);
    for (const invalid of ['foreign', '../0123456789ab', '0123456789AB', '0123456789abcd']) expect(() => wireAdmissionNames(invalid, 24)).toThrow();
    for (const unsupported of [20, 23, 26, NaN]) expect(() => wireAdmissionNames(run, unsupported)).toThrow();
});

test('public qualification CLI requires exactly owned-state and new-output paths', () => {
    expect(Object.keys(validateWireAdmissionArguments(['state.json', 'new-output']))).toEqual(['stateFile', 'output']);
    for (const args of [[], ['state.json'], ['state.json', 'output', '--reset'], ['--state', 'output'], ['', 'output'], ['state', ' ']])
        expect(() => validateWireAdmissionArguments(args)).toThrow();
});

test('retained Wire capture guard requires exact actual 7d schema/status/frame and provenance', () => {
    const original = JSON.parse(readFileSync(new URL('../../node_modules/@eosrio/hyperion-wire-plugin/fixtures/codec/ship-capture.json', import.meta.url), 'utf8'));
    const detached = structuredClone(original), selected = assertWireCapture(detached);
    expect(selected.status.id).toBe('captured-ship-status'); expect(selected.block.id).toBe('captured-ship-block-result');
    expect(detached).toEqual(original);
    const cases = [
        (value: any) => {value.sourceRevision = '6508c9e8' + '0'.repeat(32);},
        (value: any) => {value.blockNum = 6508;},
        (value: any) => {value.chainInfo.chain_id = '1'.repeat(64);},
        (value: any) => {value.handshakeUtf8 += ' ';},
        (value: any) => {value.contractDeployment = true;},
        (value: any) => {value.vectors.find((entry: any) => entry.id === 'captured-ship-status').profileId = 'wire-sysio-6508c9e8-engineering-v1';},
        (value: any) => {value.vectors.find((entry: any) => entry.id === 'captured-ship-block-result').hex += '00';},
        (value: any) => {value.vectors.find((entry: any) => entry.id === 'captured-ship-status').hex = '00';},
        (value: any) => {value.vectors.push(value.vectors.find((entry: any) => entry.id === 'captured-ship-status'));}
    ];
    for (const mutate of cases) {const invalid = structuredClone(original); mutate(invalid); expect(() => assertWireCapture(invalid)).toThrow();}
});
