// Source/metadata-only controls. Never import/execute stop-capable workload or controller files.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {NATIVE_CLEANUP_TRACE_ASSEMBLY as current, STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE as STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE, assertNativeCleanupTraceOptions as assertCurrentNativeOptions} from '../unit/native-cleanup-trace-source-admission.mjs';
import {NATIVE_CLEANUP_ASSEMBLY as priorCleanup} from '../unit/native-cleanup-source-admission.mjs';
import {NATIVE_SNAPSHOT_ASSEMBLY as priorSnapshot} from '../unit/native-snapshot-source-admission.mjs';
import {admitNativeApiSourceOptions, STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE,
    STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE} from '../unit/stateful-engineering-source-admission.mjs';
import {CURRENT_NATIVE_ASSEMBLY as priorCurrent} from '../unit/current-stateful-engineering-source-admission.mjs';
import './retained-workload-progress.test.mjs';
const root = new URL('../../', import.meta.url), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = path => readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');

test('active helpers have honest current pins and every historical snapshot keeps its original bytes', () => {
    for (const [path, expected] of Object.entries(current.helperSources))
        if (!['tests/unit/stateful-engineering-source-admission.mjs','scripts/qualification/operator-list-mongodb/contract.mjs'].includes(path))
            assert.equal(sha(canonical(path)), expected, path);
    const manifest = JSON.parse(readFileSync(new URL(current.historicalSnapshot, root)));
    const frozenF0 = JSON.parse(readFileSync(new URL('tests/fixtures/engineering-profiles/historical-f0-cleanup45/manifest.json', root)));
    for (const row of frozenF0.files) {const bytes = readFileSync(new URL(row.snapshot, root)); assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);}
    const previous = JSON.parse(readFileSync(new URL('tests/fixtures/engineering-profiles/historical-81db-snapshot45/manifest.json', root)));
    assert.equal(previous.executable, false);
    for (const row of previous.files) {const bytes = readFileSync(new URL(row.snapshot, root)); assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);}
    assert.equal(manifest.executable, false); assert.equal(manifest.sourceCommit, '8e753246b7690ea1a98e9e47bde8d1f4ace56035');
    for (const row of manifest.files) {
        const bytes = readFileSync(new URL(row.snapshot, root)); assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
    }
    const shared = 'tests/unit/stateful-engineering-source-admission.mjs';
    assert.notEqual(current.helperSources[shared], current.historicalHelperSha256);
    let prior = canonical(shared);
    for (const addition of [
        "import {STATEFUL_SDK49_SOURCE_PROFILE, admitSdk49SourceOptions} from './sdk49-indexed-source-admission.mjs';\nexport {STATEFUL_SDK49_SOURCE_PROFILE};\n",
        '    if (profile === STATEFUL_SDK49_SOURCE_PROFILE)\n        return admitSdk49SourceOptions({nativeMarker, engineeringSourceProfile: profile});\n',
        '    if (admission.profile === STATEFUL_SDK49_SOURCE_PROFILE) return admission;\n']) {
        assert.equal(prior.split(addition).length, 2); prior = prior.replace(addition, '');
    }
    assert.equal(sha(prior), current.helperSources[shared], 'The prior dispatcher remains exact after removing the new explicit routing');
    for (const addition of [
        "import {STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE, admitNativeCleanupTraceApiSourceOptions} from './native-cleanup-trace-source-admission.mjs';\nexport {STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE};\n",
        '    if (profile === STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE)\n        return admitNativeCleanupTraceApiSourceOptions({nativeMarker, engineeringSourceProfile: profile});\n',
        '    if (admission.profile === STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE) return admission;\n']) {
        assert.equal(prior.split(addition).length, 2); prior = prior.replace(addition, '');
    }
    assert.equal(sha(prior), priorCleanup.helperSources[shared], 'The f0 dispatcher predicates remain unchanged');
    for (const addition of [
        "import {STATEFUL_NATIVE_CLEANUP_API_SOURCE_PROFILE, admitNativeCleanupApiSourceOptions} from './native-cleanup-source-admission.mjs';\nexport {STATEFUL_NATIVE_CLEANUP_API_SOURCE_PROFILE};\n",
        '    if (profile === STATEFUL_NATIVE_CLEANUP_API_SOURCE_PROFILE)\n        return admitNativeCleanupApiSourceOptions({nativeMarker, engineeringSourceProfile: profile});\n',
        '    if (admission.profile === STATEFUL_NATIVE_CLEANUP_API_SOURCE_PROFILE) return admission;\n']) {
        assert.equal(prior.split(addition).length, 2); prior = prior.replace(addition, '');
    }
    assert.equal(sha(prior), priorSnapshot.helperSources[shared], 'The 81db dispatcher predicates remain unchanged');
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

test('actual installed SDK49 assembly remains refused by unchanged historical profiles', () => {
    assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorCleanup.profile}), /Git-LF helper|complete byte inventories/);
    assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorSnapshot.profile}), /Git-LF helper|complete byte inventories/);
    assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE}), /Unqualified coordinated lock source/);
    for (const profile of [undefined, STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE,
        STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE, STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE]) {
        assert.throws(() => admitNativeApiSourceOptions(profile === undefined ? {} : {engineeringSourceProfile: profile}), /Wire source revision/);
    }
});

test('original retained1480 callbacks/assertions and complete-kind17cases retain exact original bodies and budgets', () => {
    for (const [path, guard] of Object.entries(current.workloadGuards)) {
        let body = canonical(path);
        if (path === 'tests/unit/wire-managed-state-v2-native.mjs') {
            const diagnosticImport="import test from '../native/retained-workload-test.mjs';\n";
            assert.equal(body.split(diagnosticImport).length,2,'Exactly one diagnostic test header is allowed');
            body=body.replace(diagnosticImport,"import test from 'node:test';\n");
        }
        if (path === 'tests/unit/wire-managed-state-v2-native.mjs' || path === 'tests/unit/protocol-abi-history-native.mjs')
            body = body.replaceAll('STATEFUL_SDK49_SOURCE_PROFILE', 'STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE');
        if (path === 'scripts/qualification/stateful-complete-kind-mongodb/runner.mjs')
            body = body.replace("export const PLAN = Object.freeze({...HISTORICAL_PLAN, sdk: 'dc20a03f2b60ba05a3369d677222a9cf0d65d299', profile: 'stateful-sdk49-indexed-2da-linux-engineering-v1'});\n", '')
                .replace('export const HISTORICAL_PLAN =', 'export const PLAN =');
        if (path === 'scripts/qualification/operator-list-mongodb/ci.mjs' || path === 'scripts/qualification/operator-list-mongodb/runner.mjs')
            body = body.replace("from './sdk49-source-profile.mjs'", "from './linux-cleanup-source-profile.mjs'");
        if (guard.replace) body = body.replaceAll(guard.replace.selected, guard.replace.historical);
        assert.equal(sha(body), guard.historicalSha256, path + ' changed beyond the explicit profile header');
    }
    const verifier = current.qualificationVerifierGuard;
    const selected = canonical(verifier.path)
        .replace("export const PLAN = Object.freeze({...HISTORICAL_PLAN, profile: 'stateful-sdk49-indexed-2da-linux-engineering-v1', rootSDK: 'dc20a03f2b60ba05a3369d677222a9cf0d65d299', sdk: 'dc20a03f2b60ba05a3369d677222a9cf0d65d299'});\n", '')
        .replace('export const HISTORICAL_PLAN =', 'export const PLAN ='),
        historical = readFileSync(new URL(verifier.historicalSnapshot, root), 'utf8');
    assert.equal(sha(selected), verifier.selectedSha256); assert.equal(sha(historical), verifier.historicalSha256);
    assert.equal(selected.split('export const sha')[0], historical.split('export const sha')[0], 'Original PLAN/case identities/budgets remain exact');
    assert.equal(current.originalLimits.retainedWireBlocks, 1480); assert.equal(current.originalLimits.retainedWireTimeoutMS, 180000);
    assert.equal(current.originalLimits.nativeCases, 17); assert.equal(current.originalLimits.nativeComponentMS, 300000);
    assert.equal(current.acceptance.runtime, 'pending'); assert.equal(current.acceptance.physicalMongoDB, 'pending');
});

test('combined420 selects full CI through its exact419 base while every prior workflow byte stays fixed',()=>{
    const workflow=canonical('.github/workflows/build.yml'),selected='feat/stateful-indexed-schema-415',addition=', "'+selected+'"';
    const match=/^  pull_request:\n    branches: (\[[^\n]+\])/m.exec(workflow);assert(match,'Explicit existing PR base list required');
    const branches=JSON.parse(match[1]);assert.equal(branches.filter(branch=>branch===selected).length,1);assert(branches.includes('feat/mongodb-operator-lists-414'));
    assert.equal(workflow.split(addition).length,2,'Exactly one routing entry may be added');
    assert.equal(sha(workflow.replace(addition,'')),'60368ea5bbf10bf4b98cdfcc9ded61faedb1811e18f57ff11424a510fa848aad',
        'All prior branches, workloads, deadlines and the accepted diagnostic artifact path must remain byte-identical to2b');
});
