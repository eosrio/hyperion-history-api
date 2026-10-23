import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync, unlinkSync, existsSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditPortableWorkerProfiles, portableWorkerProfileLimits} from '../../scripts/qualification/portable-state-worker-profiles.ts';
import {parsePortableWorkerArguments, runPortableStateWorker, validatePortableWorkerOptions} from '../../scripts/qualification/portable-state-worker.ts';

const origin = 'http://127.0.0.1:58271';
const callFrame = {functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1};
test('CPU profile arguments preserve ordinary replay forms and require explicit native source authority', async () => {
    const files = ['state.json', 'plan.json', 'new-output'];
    expect(parsePortableWorkerArguments(files).options).toEqual({});
    expect(parsePortableWorkerArguments([...files, '--native']).options).toEqual({native: true});
    expect(parsePortableWorkerArguments([...files, '--native', '--authority-rpc', origin]).options).toEqual({native: true, authorityRpc: origin});
    expect(parsePortableWorkerArguments([...files, '--native', '--authority-rpc', origin, '--profile']).options)
        .toEqual({native: true, authorityRpc: origin, profile: true});
    for (const args of [[], files.slice(0, 2), [...files, '--profile'], [...files, '--native', '--profile'],
        [...files, '--native', '--authority-rpc'], [...files, '--native', '--authority-rpc', origin, '--foreign'],
        [...files, '--native', '--authority-rpc', origin, '--profile', '--profile']])
        expect(() => parsePortableWorkerArguments(args)).toThrow();
    for (const options of [{profile: true}, {native: true, profile: true}, {profile: 1}, {native: 'yes'}, {foreign: true},
        {native: true, authorityRpc: ''}, {native: true, authorityRpc: 'file:///tmp/rpc'},
        {native: true, authorityRpc: 'http://user:pass@127.0.0.1'}, {native: true, authorityRpc: origin + '/path'},
        {native: true, authorityRpc: origin + '?query'}, Object.create({profile: true})])
        expect(() => validatePortableWorkerOptions(options)).toThrow();
    const output = join(tmpdir(), 'hyperion-profile-rejected-' + process.pid);
    expect(existsSync(output)).toBe(false);
    await expect(runPortableStateWorker('missing-state', 'missing-plan', output, {profile: true})).rejects.toThrow('CPU profiling requires');
    expect(existsSync(output)).toBe(false);
});

async function fixture(run: (value: {output: string; directory: string; file: string; bytes: Buffer; rows: any[]; flush: any}) => Promise<void>) {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'hyperion-profile-evidence-'))), directory = join(output, 'observer/master');
    mkdirSync(directory, {recursive: true}); const file = join(directory, 'worker-123.cpuprofile');
    const bytes = Buffer.from(JSON.stringify({nodes: [{id: 1, callFrame}], samples: [1], timeDeltas: [1], startTime: 0, endTime: 1}));
    const flush = {kind: 'flush', pid: 123, success: true, droppedRecords: 0, profileState: 'saved', profilePath: file};
    const rows = [{kind: 'start', pid: 123, role: 'deserializer'}, {kind: 'profile_started', pid: 123,
        samplingIntervalMicros: portableWorkerProfileLimits.samplingIntervalMicros, maximumDurationMs: portableWorkerProfileLimits.maximumDurationMs},
    {kind: 'profile_saved', pid: 123, profilePath: file, bytes: bytes.length}, flush]; writeFileSync(file, bytes);
    try {await run({output, directory, file, bytes, rows, flush});}
    finally {const owned = resolve(output); expect(dirname(owned)).toBe(realpathSync(tmpdir()));
        expect(basename(owned).startsWith('hyperion-profile-evidence-')).toBe(true); rmSync(owned, {recursive: true, force: true});}
}

test('profile receipts bind each start to one saved ordinary file and exact bytes', async () => fixture(async ({output, rows, bytes, flush}) => {
    expect(await auditPortableWorkerProfiles(output, 'master', rows, 123, true)).toEqual([{component: 'master', pid: 123, role: 'deserializer',
        state: 'saved', file: 'observer/master/worker-123.cpuprofile', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), samples: 1, durationMicros: 1}]);
    await expect(auditPortableWorkerProfiles(output, 'master', [], 123, true)).rejects.toThrow('census');
    await expect(auditPortableWorkerProfiles(output, 'master', [rows[0]], 123, true)).rejects.toThrow('flush');
    await expect(auditPortableWorkerProfiles(output, 'master', [rows[0], ...rows], 123, true)).rejects.toThrow('duplicated');
    await expect(auditPortableWorkerProfiles(output, 'master', [...rows, flush], 123, true)).rejects.toThrow('flush');
    for (const kind of ['profile_started', 'profile_saved'])
        await expect(auditPortableWorkerProfiles(output, 'master', rows.filter(row => row.kind !== kind), 123, true)).rejects.toThrow('evidence');
    await expect(auditPortableWorkerProfiles(output, 'master', rows.map(row => row.kind === 'profile_started'
        ? {...row, maximumDurationMs: 1000} : row), 123, true)).rejects.toThrow();
}));

test('missing, foreign, failed and excess profile evidence cannot satisfy capture', async () => fixture(async ({output, directory, file, rows, flush}) => {
    for (const patch of [{profileState: 'failed'}, {droppedRecords: 1}, {success: false},
        {profilePath: join(output, 'foreign.cpuprofile')}, {profilePath: join(directory, 'worker-124.cpuprofile')}])
        await expect(auditPortableWorkerProfiles(output, 'master', [...rows.filter(row => row.kind !== 'flush'), {...flush, ...patch}], 123, true)).rejects.toThrow();
    const excess = join(directory, 'worker-999.cpuprofile'); writeFileSync(excess, '{}');
    await expect(auditPortableWorkerProfiles(output, 'master', rows, 123, true)).rejects.toThrow('unexpected'); unlinkSync(excess);
    unlinkSync(file); await expect(auditPortableWorkerProfiles(output, 'master', rows, 123, true)).rejects.toThrow();
}));

test('capture census cannot omit a parent-observed worker or accept orphan profile events', async () => fixture(async ({output, rows}) => {
    const fork = {kind: 'worker_fork', pid: 123, childPid: 456};
    const exit = {kind: 'worker_exit', pid: 123, childPid: 456, code: 0, signal: null};
    await expect(auditPortableWorkerProfiles(output, 'master', [...rows, fork, exit], 123, true)).rejects.toThrow('census');
    for (const kind of ['flush', 'profile_started', 'profile_saved', 'exit', 'observer_error'])
        await expect(auditPortableWorkerProfiles(output, 'master', [...rows, {kind, pid: 456}], 123, true)).rejects.toThrow('orphan');
    await expect(auditPortableWorkerProfiles(output, 'master', [...rows, fork], 123, false)).rejects.toThrow('census');
    await expect(auditPortableWorkerProfiles(output, 'master', rows, 456, true)).rejects.toThrow('untracked');
    await expect(auditPortableWorkerProfiles(output, 'master', rows, 0, true)).rejects.toThrow('primary PID');
    await expect(auditPortableWorkerProfiles(output, 'master', [...rows, {...rows[0], pid: 456}], 123, true)).rejects.toThrow('untracked');
    await expect(auditPortableWorkerProfiles(output, 'master', [...rows, fork, {...rows[0], pid: 456, parentPid: 789}], 123, true))
        .rejects.toThrow('parent differs');
    for (const forks of [[fork, fork], [{...fork, childPid: 123}], [{...fork, pid: 789}],
        [{...fork, pid: 789}, {kind: 'worker_fork', pid: 456, childPid: 789}]])
        await expect(auditPortableWorkerProfiles(output, 'master', [...rows, ...forks], 123, true)).rejects.toThrow();
}));

test('malformed, unsampled, mismatched and excessive CPU files fail the artifact gate', async () => fixture(async ({output, file, rows}) => {
    const base = {nodes: [{id: 1, callFrame}], samples: [1], timeDeltas: [1], startTime: 0, endTime: 1};
    for (const value of ['{', JSON.stringify({...base, nodes: []}), JSON.stringify({...base, nodes: [{id: 1}, {id: 1}]}),
        JSON.stringify({...base, nodes: [{id: 1}]}), JSON.stringify({...base, nodes: [{id: 1, callFrame: {...callFrame, lineNumber: -2}}]}),
        JSON.stringify({...base, nodes: [{id: 1, callFrame, children: [2]}]}),
        JSON.stringify({...base, nodes: [{id: 1, callFrame}, {id: 2, callFrame}]}),
        JSON.stringify({...base, nodes: [{id: 1, callFrame, children: [2]}, {id: 2, callFrame, children: [1]}]}),
        JSON.stringify({...base, samples: []}), JSON.stringify({...base, samples: [2]}), JSON.stringify({...base, timeDeltas: []}),
        JSON.stringify({...base, timeDeltas: [-1]}), JSON.stringify({...base, endTime: 0})]) {
        writeFileSync(file, value); rows.find(row => row.kind === 'profile_saved')!.bytes = Buffer.byteLength(value);
        await expect(auditPortableWorkerProfiles(output, 'master', rows, 123, true)).rejects.toThrow();
    }
    writeFileSync(file, '{}'); truncateSync(file, portableWorkerProfileLimits.maximumBytes + 1);
    await expect(auditPortableWorkerProfiles(output, 'master', rows, 123, true)).rejects.toThrow('bound');
}));

test('disabled CPU capture requires disabled flushes and no residual profile files', async () => fixture(async ({output, file, rows, flush}) => {
    const disabled = [rows[0], {...flush, profileState: 'disabled', profilePath: null}];
    await expect(auditPortableWorkerProfiles(output, 'master', disabled, 123, false)).rejects.toThrow('unexpected');
    unlinkSync(file); expect(await auditPortableWorkerProfiles(output, 'master', disabled, 123, false)).toEqual([
        {component: 'master', pid: 123, role: 'deserializer', state: 'disabled', file: null}]);
    await expect(auditPortableWorkerProfiles(output, 'master', rows, 123, false)).rejects.toThrow();
}));

for (const mode of ['control', 'profile']) test(`actual native observer ${mode} validates profile capture and original shutdown`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--experimental-transform-types',
        fileURLToPath(new URL('./portable-state-worker-profiles.mjs', import.meta.url)), mode], {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout, stderr}).toMatchObject({code: 0});
    expect(stderr.replace(/\(node:\d+\) ExperimentalWarning: Transform Types is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/, '')).toBe('');
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, mode, ordinaryBoundedFilesVerified: true,
        actualSampledWorkload: mode === 'profile', fullWorkerQualification: false});
}, 20000);
