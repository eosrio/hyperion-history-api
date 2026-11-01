// Inert file collection/materialization shared by the actual replay snapshot path and focused controls.
// No admission/runtime module is imported, and no child, service, socket or process stop exists here.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export const engineeringAdmissionSourcePaths = Object.freeze([
    'tests/unit/stateful-engineering-source-admission.mjs',
    'tests/unit/sdk49-indexed-source-admission.mjs',
    'tests/fixtures/engineering-profiles/sdk49-indexed-linux.json',
    'scripts/qualification/indexed-schema-mongodb/assembly.mjs',
    'scripts/qualification/indexed-schema-mongodb/assembly.json',
    'scripts/qualification/indexed-schema-mongodb/sdk49-ci-source-check.mjs',
    'scripts/qualification/indexed-schema-mongodb/sdk49-ci-routing.md',
    '.github/workflows/build.yml',
    'scripts/qualification/operator-list-mongodb/sdk49-source-profile.mjs',
    'scripts/qualification/operator-list-mongodb/assembly-diagnostics.test.mjs',
    'scripts/qualification/operator-list-mongodb/ci.mjs',
    'scripts/qualification/operator-list-mongodb/runner.mjs',
    'scripts/qualification/stateful-complete-kind-mongodb/runner.mjs',
    'scripts/qualification/wire-source-snapshot.mjs',
    'scripts/qualification/wire-source-snapshot.test.mjs',
    'tests/native/current-stateful-source-profile.test.mjs',
    'tests/native/stateful-complete-kind-codec-profile.test.mjs',
    'tests/unit/stateful-complete-kind-source-admission-native.mjs',
    'tests/unit/protocol-abi-history-native.mjs',
    'tests/unit/wire-managed-state-v2-native.mjs',
    'tests/unit/portable-state-source-fixture.mjs',
    'tests/unit/stateful-host-fixture.mjs',
    'tests/native/retained-workload-progress.mjs',
    'tests/native/retained-workload-test.mjs',
    'tests/native/retained-workload-progress.test.mjs',
    'scripts/qualification/indexed-schema-mongodb/retained-wire-diagnostics.md',
    'tests/unit/current-stateful-engineering-source-admission.mjs',
    'tests/unit/native-snapshot-source-admission.mjs',
    'tests/unit/native-cleanup-source-admission.mjs',
    'tests/unit/native-cleanup-trace-source-admission.mjs',
    'tests/fixtures/engineering-profiles/current-native45-linux.json',
    'tests/fixtures/engineering-profiles/native-snapshot-linux.json',
    'tests/fixtures/engineering-profiles/native-cleanup-linux.json',
    'tests/fixtures/engineering-profiles/native-cleanup-trace-linux.json',
    'scripts/qualification/operator-list-mongodb/linux-source-profile.mjs',
    'scripts/qualification/operator-list-mongodb/linux-snapshot-source-profile.mjs',
    'scripts/qualification/operator-list-mongodb/linux-cleanup-source-profile.mjs',
    'scripts/qualification/operator-list-mongodb/linux-profile.json',
    'scripts/qualification/operator-list-mongodb/snapshot-profile.json',
    'scripts/qualification/operator-list-mongodb/cleanup-profile.json',
    'scripts/qualification/operator-list-mongodb/source-profile.mjs',
    'scripts/qualification/operator-list-mongodb/profile.json',
    'scripts/qualification/operator-list-mongodb/inventory.mjs',
    'scripts/qualification/operator-list-mongodb/assembly-diagnostics.mjs',
    'scripts/qualification/operator-list-mongodb/contract.mjs',
]);
const maximumBytes = 64 * 1024 * 1024;
const portable = path => {
    assert.ok(typeof path === 'string' && /^(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+$/.test(path)
        && path.split('/').every(part => part !== '.' && part !== '..'), 'Invalid snapshot source path');
    return path;
};

/**
 * @param {{repo: string, prefix: string, componentFiles: ReadonlyMap<string, Uint8Array>, runtimeSources: readonly string[],
 * engineeringSelected: boolean, output?: string, readSource: (path: string) => Promise<Buffer>}} options
 * @returns {Promise<Record<string, string>>}
 */
export async function captureWireSourceSnapshot({repo, prefix, componentFiles, runtimeSources, engineeringSelected, output, readSource}) {
    assert.equal(typeof engineeringSelected, 'boolean'); assert.equal(typeof readSource, 'function'); portable(prefix);
    const members = new Map(); let total = 0;
    const add = (file, bytes) => {
        portable(file); assert.ok(bytes instanceof Uint8Array, 'Raw snapshot source bytes required');
        assert.ok(!members.has(file), 'Duplicate snapshot source'); total += bytes.byteLength;
        assert.ok(total <= maximumBytes, 'source evidence exceeds byte bound'); members.set(file, bytes);
    };
    for (const [file, bytes] of componentFiles) add(prefix + '/' + portable(file), bytes);
    // Every engineering choice loads the same dispatcher graph, including historical/default-refusal branches.
    if (engineeringSelected) for (const file of engineeringAdmissionSourcePaths) add(file, await readSource(join(repo, file)));
    for (const file of runtimeSources) if (!members.has(file)) add(file, await readSource(join(repo, portable(file))));
    /** @type {Record<string, string>} */
    const hashes = {};
    for (const [file, bytes] of members) {
        hashes[file] = createHash('sha256').update(bytes).digest('hex');
        if (output) {
            const target = join(output, 'sources', file); await mkdir(dirname(target), {recursive: true});
            await writeFile(target, bytes, {flag: 'wx'});
        }
    }
    return hashes;
}
