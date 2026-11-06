// Explicit Linux Git-LF profile. Never selected by platform fallback; emissions stay byte-exact.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {OPERATOR_LIST_PROFILE as historicalProfile, observeOperatorListAssembly} from './source-profile.mjs';
import {diagnosticDirectory, retainAdmission, writeAssemblyDiagnostic} from './assembly-diagnostics.mjs';
import {sha} from './contract.mjs';
const freeze = value => {if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);} return value;};
export const OPERATOR_LIST_ASSEMBLY = freeze(JSON.parse(readFileSync(new URL('./cleanup-profile.json', import.meta.url))));
export const OPERATOR_LIST_PROFILE = OPERATOR_LIST_ASSEMBLY.profile;
assert.equal(OPERATOR_LIST_PROFILE, 'operator-list-mongodb-root741-native429-source-9c3db03-linux-gitlf-engineering');
assert.equal(OPERATOR_LIST_ASSEMBLY.schemaVersion, 1); assert.equal(OPERATOR_LIST_ASSEMBLY.qualificationOnly, true);
const digest = value => sha(Buffer.from(JSON.stringify(value)));
const equal = (actual, expected, label) => assert.deepEqual(actual, expected, 'Unqualified Linux operator-list ' + label);
const defaultRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function assertOperatorListObservation(observed) {
    const p = OPERATOR_LIST_ASSEMBLY.pins;
    equal(Object.keys(observed).sort(), ['profile', 'sourceFiles', 'trees', 'runtime', 'pins'].sort(), 'observation shape');
    equal(observed.profile, OPERATOR_LIST_PROFILE, 'explicit profile');
    equal(observed.sourceFiles, OPERATOR_LIST_ASSEMBLY.sourceFiles, 'source/manifest/dependency text');
    equal(observed.trees, OPERATOR_LIST_ASSEMBLY.trees, 'complete byte inventories');
    equal(observed.pins, {rootSDK: p.rootSDK, nativeSDK: p.nativeSDK, Wire: p.Wire, bun: p.bun,
        rootCompiler: p.typescript, nativeCompiler: p.typescript, rootDriver: p.driver, nativeDriver: p.driver}, 'coordinated pins');
    equal(Object.keys(observed.runtime).sort(), ['node', 'executable', 'executableSha256', 'platform', 'arch'].sort(), 'runtime shape');
    equal(observed.runtime.platform, OPERATOR_LIST_ASSEMBLY.platform.os, 'platform');
    equal(observed.runtime.arch, OPERATOR_LIST_ASSEMBLY.platform.arch, 'architecture');
    assert.equal(typeof observed.runtime.executable, 'string'); assert.ok(observed.runtime.executable.length > 0);
    assert.match(observed.runtime.executableSha256, /^[a-f0-9]{64}$/);
    const candidate = observed.runtime.node === OPERATOR_LIST_ASSEMBLY.engineeringCandidate.node;
    if (!candidate) {
        const runtime = OPERATOR_LIST_ASSEMBLY.runtimeEvidence.find(value => value.node === observed.runtime.node);
        assert.ok(runtime, 'Unqualified Linux operator-list Node version');
        equal(observed.runtime.executableSha256, runtime.executableSha256, 'reviewed executable bytes');
    }
    return freeze({qualificationOnly: true, runtimeAcceptance: 'pending', engineeringRuntimeCandidate: candidate,
        runtimeEvidence: candidate ? 'exact-version engineering candidate; actual executable hash recorded, runtime acceptance pending'
            : 'retained caller/runtime observed; repaired native candidate requires actual Linux qualification',
        productSource: OPERATOR_LIST_ASSEMBLY.productSource, assemblySha256: digest(OPERATOR_LIST_ASSEMBLY),
        observationSha256: digest(observed), ...observed});
}

function observe(root) {
    assert.equal(process.versions.bun, undefined, 'Native Node runtime required for the Linux engineering profile');
    assert.equal(process.release.name, 'node', 'Native Node runtime required for the Linux engineering profile');
    // Reuse only the read-only collector's fixed paths/pins. Its historical assertion/default remain unchanged.
    const snapshot = observeOperatorListAssembly(historicalProfile, root);
    return {...snapshot, observed: {...snapshot.observed, profile: OPERATOR_LIST_PROFILE,
        runtime: {...snapshot.observed.runtime, platform: process.platform, arch: process.arch}}};
}
export function admitOperatorListAssembly(profile, root = defaultRoot) {
    equal(profile, OPERATOR_LIST_PROFILE, 'profile selection');
    return assertOperatorListObservation(observe(root).observed);
}
export function diagnoseOperatorListAssembly(directory, root = defaultRoot) {
    diagnosticDirectory(directory); const snapshot = observe(root);
    const provenance = {platform: process.platform, arch: process.arch, environmentObservations: Object.fromEntries(
        ['GITHUB_SHA', 'GITHUB_WORKFLOW_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_OS', 'RUNNER_ARCH']
            .map(name => [name, (process.env[name] ?? '').slice(0, 512)]))};
    return retainAdmission(() => assertOperatorListObservation(snapshot.observed), admission => writeAssemblyDiagnostic({
        ...snapshot, directory, expected: OPERATOR_LIST_ASSEMBLY, admission, provenance}));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--diagnostics'), 'Use only the explicit Linux profile and optional diagnostics');
    console.log(JSON.stringify(args.length ? diagnoseOperatorListAssembly(args[1]) : admitOperatorListAssembly(OPERATOR_LIST_PROFILE), null, 2));
}
