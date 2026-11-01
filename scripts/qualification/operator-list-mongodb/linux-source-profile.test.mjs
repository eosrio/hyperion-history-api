// Actual captured observation and modeled negative inputs only; no child, controller, DB or service.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {OPERATOR_LIST_ASSEMBLY as profile, OPERATOR_LIST_PROFILE, assertOperatorListObservation, admitOperatorListAssembly} from './linux-source-profile.mjs';
import {OPERATOR_LIST_PROFILE as historicalProfile, assertOperatorListObservation as historicalAssertion} from './source-profile.mjs';
const captured = JSON.parse(readFileSync(new URL('../../../tests/fixtures/engineering-profiles/operator-list-linux-observation.json', import.meta.url))).observed;
const observation = () => structuredClone(captured);

test('explicit Linux profile admits the independently reviewed raw550 observations and distinct native429 graph', () => {
    for (const runtime of profile.runtimeEvidence) {
        const value = observation(); value.runtime.node = runtime.node; value.runtime.executableSha256 = runtime.executableSha256;
        const admitted = assertOperatorListObservation(value);
        assert.equal(admitted.trees.rootBuild.files, 550); assert.equal(admitted.trees.nativeBuild.files, 45);
        assert.equal(admitted.trees.nativeSDK.files, 33); assert.equal(admitted.engineeringRuntimeCandidate, false);
        assert.equal(admitted.runtimeAcceptance, 'pending'); assert.equal(admitted.qualificationOnly, true);
    }
    assert.notEqual(profile.pins.rootSDK, profile.pins.nativeSDK);
    const prior = observation(); prior.profile = historicalProfile;
    assert.throws(() => historicalAssertion(prior), /complete byte inventories/);
    assert.throws(() => admitOperatorListAssembly(historicalProfile), /profile selection/);
    assert.throws(() => admitOperatorListAssembly(undefined), /profile selection/);
});

test('Linux profile refuses Windows emission, wrong source/native/SDK/driver/binary and unknown runtime without fallback', () => {
    for (const mutate of [v => {v.profile = historicalProfile;}, v => {v.trees.rootBuild.sha256 = '6fdcae1f6f79a2dda709dc574f28a8888985c4f8bc18071aeffe73dd951ab419';},
        v => {v.runtime.platform = 'win32';}, v => {v.runtime.arch = 'arm64';}, v => {v.runtime.executableSha256 = 'a'.repeat(64);},
        v => {v.runtime.node = 'v26.13.1';}, v => {v.pins.nativeSDK = v.pins.rootSDK;}, v => {v.trees.nativeBuild.files = 39;},
        v => {v.trees.nativeSDK.files = 31;}, v => {v.trees.nativeDriver.sha256 = '0'.repeat(64);},
        v => {v.trees.nativeBSON.sha256 = v.trees.rootBSON.sha256;}, v => {v.sourceFiles[0].sha256 = '0'.repeat(64);},
        v => {v.runtime.extra = 'override';}, v => {v.extra = 'override';}]) {
        const value = observation(); mutate(value); assert.throws(() => assertOperatorListObservation(value));
    }
});

test('exact26.13 candidate records its actual hash with runtime acceptance pending and inherits no26.4 status', () => {
    const modeled = observation(); modeled.runtime.node = 'v26.13.0'; modeled.runtime.executable = '/modeled/no-execution';
    modeled.runtime.executableSha256 = 'b'.repeat(64);
    const result = assertOperatorListObservation(modeled);
    assert.equal(result.engineeringRuntimeCandidate, true); assert.equal(result.runtimeAcceptance, 'pending');
    assert.equal(result.runtime.executableSha256, 'b'.repeat(64)); assert.match(result.runtimeEvidence, /engineering candidate/);
    assert.equal(profile.runtimeEvidence.some(value => value.node === modeled.runtime.node), false);
    assert.equal(profile.assemblyEvidence.originalAdmission, 'rejected'); assert.equal(profile.assemblyEvidence.normalizationForAdmission, false);
});
