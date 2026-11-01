// Default admission is read-only. Explicit diagnostics write bounded evidence only; no client, child, socket or service.
import assert from 'node:assert/strict';
import {lstatSync, readFileSync, realpathSync} from 'node:fs';
import {isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {inventory} from './inventory.mjs';
import {sha} from './contract.mjs';
import {diagnosticDirectory, retainAdmission, writeAssemblyDiagnostic} from './assembly-diagnostics.mjs';
const defaultRoot = fileURLToPath(new URL('../../../', import.meta.url));
const data = JSON.parse(readFileSync(new URL('./profile.json', import.meta.url)));
const freeze = value => {if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);} return value;};
export const OPERATOR_LIST_ASSEMBLY = freeze(data);
export const OPERATOR_LIST_PROFILE = OPERATOR_LIST_ASSEMBLY.profile;
assert.equal(OPERATOR_LIST_PROFILE, 'operator-list-mongodb-root741-native429-47d5c2c-engineering');
assert.equal(OPERATOR_LIST_ASSEMBLY.schemaVersion, 1); assert.equal(OPERATOR_LIST_ASSEMBLY.qualificationOnly, true);
const equal = (value, expected, label) => assert.deepEqual(value, expected, 'Unqualified operator-list ' + label);
const digest = value => sha(Buffer.from(JSON.stringify(value)));

/** Pure negative controls use observations, never caller-provided expected profiles. */
export function assertOperatorListObservation(observed) {
    equal(Object.keys(observed).sort(), ['profile', 'sourceFiles', 'trees', 'runtime', 'pins'].sort(), 'observation shape');
    equal(observed.profile, OPERATOR_LIST_PROFILE, 'profile');
    equal(observed.sourceFiles, OPERATOR_LIST_ASSEMBLY.sourceFiles, 'source/manifest/dependency text');
    equal(observed.trees, OPERATOR_LIST_ASSEMBLY.trees, 'complete byte inventories');
    equal(observed.pins, {rootSDK: OPERATOR_LIST_ASSEMBLY.pins.rootSDK, nativeSDK: OPERATOR_LIST_ASSEMBLY.pins.nativeSDK,
        Wire: OPERATOR_LIST_ASSEMBLY.pins.Wire, bun: OPERATOR_LIST_ASSEMBLY.pins.bun, rootCompiler: OPERATOR_LIST_ASSEMBLY.pins.typescript,
        nativeCompiler: OPERATOR_LIST_ASSEMBLY.pins.typescript, rootDriver: OPERATOR_LIST_ASSEMBLY.pins.driver, nativeDriver: OPERATOR_LIST_ASSEMBLY.pins.driver}, 'coordinated pins');
    assert.ok(OPERATOR_LIST_ASSEMBLY.pins.node.includes(observed.runtime.node), 'Unqualified operator-list Node version');
    assert.match(observed.runtime.executableSha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof observed.runtime.executable, 'string'); assert.ok(observed.runtime.executable.length > 0);
    equal(Object.keys(observed.runtime).sort(), ['node', 'executable', 'executableSha256'].sort(), 'runtime observation shape');
    return freeze({profile: OPERATOR_LIST_PROFILE, qualificationOnly: true, productSource: OPERATOR_LIST_ASSEMBLY.productSource,
        assemblySha256: digest(OPERATOR_LIST_ASSEMBLY), observationSha256: digest(observed), ...observed});
}
const text = bytes => Buffer.from(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes).replaceAll('\r\n', '\n'));
const gitPin = (value, name, commit) => assert.ok(['git+https://github.com/eosrio/', 'git+ssh://git@github.com/eosrio/']
    .some(prefix => value === prefix + name + '.git#' + commit), 'Unqualified operator-list installed source pin');

/** Exact new profile only: no default source override and no old profile acceptance. */
function observeOperatorListAssembly(profile, root) {
    equal(profile, OPERATOR_LIST_PROFILE, 'profile selection'); root = realpathSync(root);
    const path = name => {
        assert.ok(typeof name === 'string' && !isAbsolute(name) && !name.includes('\\'));
        const candidate = resolve(root, name), actual = realpathSync(candidate), inner = relative(root, actual);
        assert.ok(inner && inner !== '..' && !inner.startsWith('../') && !inner.startsWith('..\\') && !isAbsolute(inner), 'Operator-list assembly path escaped checkout');
        assert.equal(lstatSync(candidate).isSymbolicLink(), false); return actual;
    };
    const read = name => {
        const selected = path(name), stat = lstatSync(selected);
        assert.ok(stat.isFile() && stat.size <= 4 * 1024 * 1024, 'Operator-list assembly metadata bound');
        const bytes = readFileSync(selected); assert.equal(bytes.length, stat.size); return bytes;
    };
    const json = name => JSON.parse(text(read(name)));
    const files = OPERATOR_LIST_ASSEMBLY.sourceFiles.map(expected => {
        const bytes = expected.textLF ? text(read(expected.path)) : read(expected.path);
        return {path: expected.path, bytes: bytes.length, sha256: sha(bytes), textLF: expected.textLF};
    });
    const inventories = {};
    const trees = Object.fromEntries(Object.entries(OPERATOR_LIST_ASSEMBLY.trees).map(([name, expected]) => {
        const rows = inventory(path(expected.path), {textLF: expected.textLF});
        inventories[name] = rows;
        return [name, {path: expected.path, files: rows.length, sha256: digest(rows), textLF: expected.textLF}];
    }));
    const rootPackage = json('package.json'), nativePackage = json('packages/backend-mongodb/package.json');
    const rootLock = json('package-lock.json'), nativeLock = json('packages/backend-mongodb/package-lock.json');
    const p = OPERATOR_LIST_ASSEMBLY.pins;
    gitPin(rootPackage.dependencies['@eosrio/hyperion-sdk'], 'hyperion-sdk', p.rootSDK);
    gitPin(nativePackage.devDependencies['@eosrio/hyperion-sdk'], 'hyperion-sdk', p.nativeSDK);
    gitPin(rootPackage.dependencies['@eosrio/hyperion-wire-plugin'], 'hyperion-wire-plugin', p.Wire);
    gitPin(rootLock.packages['node_modules/@eosrio/hyperion-sdk'].resolved, 'hyperion-sdk', p.rootSDK);
    gitPin(rootLock.packages['packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk'].resolved, 'hyperion-sdk', p.nativeSDK);
    gitPin(nativeLock.packages['node_modules/@eosrio/hyperion-sdk'].resolved, 'hyperion-sdk', p.nativeSDK);
    const observed = {profile, sourceFiles: files, trees, runtime: {node: process.version, executable: process.execPath,
        executableSha256: sha(readFileSync(process.execPath))}, pins: {rootSDK: p.rootSDK, nativeSDK: p.nativeSDK, Wire: p.Wire,
        bun: text(read('.bun-version')).toString().trim(), rootCompiler: json('node_modules/typescript/package.json').version,
        nativeCompiler: json('packages/backend-mongodb/node_modules/typescript/package.json').version,
        rootDriver: json('node_modules/mongodb/package.json').version, nativeDriver: json('packages/backend-mongodb/node_modules/mongodb/package.json').version}};
    return {root, observed, inventories};
}
export function admitOperatorListAssembly(profile, root = defaultRoot) {
    return assertOperatorListObservation(observeOperatorListAssembly(profile, root).observed);
}
/** Evidence capture never changes the strict profile, original rejection or downstream service admission. */
export function diagnoseOperatorListAssembly(directory, root = defaultRoot) {
    diagnosticDirectory(directory);
    const snapshot = observeOperatorListAssembly(OPERATOR_LIST_PROFILE, root);
    const provenance = {platform: process.platform, arch: process.arch, environmentObservations: Object.fromEntries(
        ['GITHUB_SHA', 'GITHUB_WORKFLOW_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'RUNNER_OS', 'RUNNER_ARCH']
            .map(name => [name, (process.env[name] ?? '').slice(0, 512)]))};
    return retainAdmission(() => assertOperatorListObservation(snapshot.observed), admission => writeAssemblyDiagnostic({
        ...snapshot, directory, expected: OPERATOR_LIST_ASSEMBLY, admission, provenance}));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--diagnostics'),
        'Admission selects only the fixed list fixture profile, with an optional bounded diagnostic directory');
    const result = args.length ? diagnoseOperatorListAssembly(args[1]) : admitOperatorListAssembly(OPERATOR_LIST_PROFILE);
    console.log(JSON.stringify(result, null, 2));
}
