// Source/metadata-only controls. Never import/execute stop-capable workload or controller files.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {NATIVE_SNAPSHOT_ASSEMBLY as current, STATEFUL_NATIVE_SNAPSHOT_API_SOURCE_PROFILE as STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE, assertNativeSnapshotOptions as assertCurrentNativeOptions} from '../unit/native-snapshot-source-admission.mjs';
import {admitNativeApiSourceOptions, STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE,
    STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE} from '../unit/stateful-engineering-source-admission.mjs';
import {CURRENT_NATIVE_ASSEMBLY as priorCurrent} from '../unit/current-stateful-engineering-source-admission.mjs';
const root = new URL('../../', import.meta.url), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = path => readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');

test('active helpers have honest current pins and every historical snapshot keeps its original bytes', () => {
    for (const [path, expected] of Object.entries(current.helperSources)) assert.equal(sha(canonical(path)), expected, path);
    const manifest = JSON.parse(readFileSync(new URL(current.historicalSnapshot, root)));
    assert.equal(manifest.executable, false); assert.equal(manifest.sourceCommit, '8e753246b7690ea1a98e9e47bde8d1f4ace56035');
    for (const row of manifest.files) {
        const bytes = readFileSync(new URL(row.snapshot, root)); assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
    }
    const shared = 'tests/unit/stateful-engineering-source-admission.mjs';
    assert.notEqual(current.helperSources[shared], current.historicalHelperSha256);
    let prior = canonical(shared);
    for (const addition of [
        "import {STATEFUL_NATIVE_SNAPSHOT_API_SOURCE_PROFILE, admitNativeSnapshotApiSourceOptions} from './native-snapshot-source-admission.mjs';\nexport {STATEFUL_NATIVE_SNAPSHOT_API_SOURCE_PROFILE};\n",
        '    if (profile === STATEFUL_NATIVE_SNAPSHOT_API_SOURCE_PROFILE)\n        return admitNativeSnapshotApiSourceOptions({nativeMarker, engineeringSourceProfile: profile});\n',
        '    if (admission.profile === STATEFUL_NATIVE_SNAPSHOT_API_SOURCE_PROFILE) return admission;\n']) {
        assert.equal(prior.split(addition).length, 2); prior = prior.replace(addition, '');
    }
    assert.equal(sha(prior), priorCurrent.helperSources[shared], 'The e6 dispatcher predicates remain unchanged');
    for (const addition of [
        "import {STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE, admitCurrentNativeApiSourceOptions} from './current-stateful-engineering-source-admission.mjs';\nexport {STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE};\n",
        '    if (profile === STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE)\n        return admitCurrentNativeApiSourceOptions({nativeMarker, engineeringSourceProfile: profile});\n',
        '    if (admission.profile === STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE) return admission;\n']) {
        assert.equal(prior.split(addition).length, 2, 'Only the reviewed additive dispatch differs'); prior = prior.replace(addition, '');
    }
    assert.equal(sha(prior), current.historicalHelperSha256, 'All old profile predicates/default branches remain byte-identical');
});

test('current selector refuses getters, unknown/default/historical selections before any source admission', () => {
    let accessed = 0;
    for (const input of [undefined, {}, {engineeringSourceProfile: 'stateful-owner-v2-7412889-69a6606-complete-kind-engineering'},
        {engineeringSourceProfile: 'unknown'}, {engineeringSourceProfile: STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE, nativeMarker: 'true'},
        {get engineeringSourceProfile() {accessed++; return STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE;}},
        Object.create(null), {engineeringSourceProfile: STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE, extra: true}]) {
        assert.throws(() => assertCurrentNativeOptions(input));
    }
    assert.equal(accessed, 0);
    assert.deepEqual(assertCurrentNativeOptions({engineeringSourceProfile: STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE, nativeMarker: false}),
        {profile: STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE, nativeMarker: false});
});

test('actual installed current native45 remains refused by the unchanged historical native39 and older profiles', () => {
    assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE}), /complete-kind native Git-LF package/);
    for (const profile of [undefined, STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE,
        STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE]) {
        assert.throws(() => admitNativeApiSourceOptions(profile === undefined ? {} : {engineeringSourceProfile: profile}), /Wire source revision/);
    }
});

test('original retained1480 callbacks/assertions and complete-kind17cases retain exact original bodies and budgets', () => {
    for (const [path, guard] of Object.entries(current.workloadGuards)) {
        let body = canonical(path);
        if (guard.replace) body = body.replaceAll(guard.replace.selected, guard.replace.historical);
        assert.equal(sha(body), guard.historicalSha256, path + ' changed beyond the explicit profile header');
    }
    assert.equal(current.originalLimits.retainedWireBlocks, 1480); assert.equal(current.originalLimits.retainedWireTimeoutMS, 180000);
    assert.equal(current.originalLimits.nativeCases, 17); assert.equal(current.originalLimits.nativeComponentMS, 300000);
    assert.equal(current.acceptance.runtime, 'pending'); assert.equal(current.acceptance.physicalMongoDB, 'pending');
});
