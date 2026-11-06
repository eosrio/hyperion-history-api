// Pure observations and read-only profile selection. Never import the stop-capable CI wrapper.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {sha} from './contract.mjs';
import {OPERATOR_LIST_ASSEMBLY as profile, OPERATOR_LIST_PROFILE, assertOperatorListObservation, admitOperatorListAssembly} from './source-profile.mjs';
import {admitNativeApiSourceOptions} from '../../../tests/unit/stateful-engineering-source-admission.mjs';
const observed = () => ({profile: OPERATOR_LIST_PROFILE, sourceFiles: structuredClone(profile.sourceFiles), trees: structuredClone(profile.trees),
    runtime: {node: 'v24.22.1', executable: '/reviewed/node', executableSha256: 'a'.repeat(64)},
    pins: {rootSDK: profile.pins.rootSDK, nativeSDK: profile.pins.nativeSDK, Wire: profile.pins.Wire, bun: profile.pins.bun,
        rootCompiler: profile.pins.typescript, nativeCompiler: profile.pins.typescript, rootDriver: profile.pins.driver, nativeDriver: profile.pins.driver}});
test('new list qualification profile binds exact distinct caller/receiving SDK and source/native emissions', () => {
    const result = assertOperatorListObservation(observed()); assert.equal(result.qualificationOnly, true);
    for (const node of profile.pins.node) {const value = observed(); value.runtime.node = node; assert.equal(assertOperatorListObservation(value).runtime.node, node);}
    assert.equal(result.trees.nativeBuild.files, 45); assert.equal(result.trees.rootBuild.files, 550);
    assert.notEqual(result.pins.rootSDK, result.pins.nativeSDK); assert.equal(result.productSource.commit, '47d5c2c6552788146dac51cfef086b2c766b2b19');
    for (const mutate of [v => {v.profile = 'default';}, v => {v.pins.nativeSDK = v.pins.rootSDK;},
        v => {v.trees.nativeBuild.files = 39;}, v => {v.trees.nativeBuild.sha256 = '0'.repeat(64);},
        v => {v.trees.rootBuild.sha256 = '362a4ef3d8c1ce3afcfa7a22c0eab5efa7bfcb4047a64d82005e38cf20a8d2fe';},
        v => {v.trees.nativeSDK.files = 31;}, v => {v.trees.rootDriver.sha256 = '0'.repeat(64);},
        v => {v.trees.nativeBSON.sha256 = v.trees.rootBSON.sha256;}, v => {v.sourceFiles[0].sha256 = '0'.repeat(64);},
        v => {v.runtime.node = 'v22.0.0';}, v => {v.runtime.node = 'v24.22.2';}, v => {v.extra = 'caller override';}]) {
        const value = observed(); mutate(value); assert.throws(() => assertOperatorListObservation(value));
    }
});
test('new source selection cannot override or silently reuse the frozen complete-kind profile', () => {
    assert.throws(() => admitOperatorListAssembly('stateful-owner-v2-7412889-69a6606-complete-kind-engineering'), /profile selection/);
    assert.throws(() => admitOperatorListAssembly(undefined), /profile selection/);
    assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: OPERATOR_LIST_PROFILE}), /Unknown engineering source profile/);
    // The old gate remains an immutable source record, not an alias accepting native45.
    const old = readFileSync(new URL('../../../tests/unit/stateful-engineering-source-admission.mjs', import.meta.url));
    assert.equal(sha(old.toString('utf8').replaceAll('\r\n', '\n')), '9c4dd22874e2a6610a4aa07dc6ec64f219ec42e539eba2e240abfc7c85e621ed');
});
