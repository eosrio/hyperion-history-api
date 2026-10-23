/** Qualification evidence only; a saved CPU profile cannot turn a failed replay into success. */
import assert from 'node:assert/strict';
import {readdir, realpath} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {boundedPortableFile, ordinaryPortablePath, portableSourceHash, portableSourceLimits} from './portable-state-worker-source.ts';

export const portableWorkerProfileLimits = Object.freeze({maximumBytes: 32 * 1024 * 1024,
    maximumProcesses: 64, maximumDurationMs: portableSourceLimits.runMs, samplingIntervalMicros: 10000});

export function portableWorkerProfileEnvironment(enabled: boolean): NodeJS.ProcessEnv {
    assert.equal(typeof enabled, 'boolean', 'CPU profile option must be boolean');
    return {ES198_CPU_PROFILE: enabled ? '1' : '0',
        ...(enabled ? {ES198_PROFILE_MAX_MS: String(portableWorkerProfileLimits.maximumDurationMs)} : {})};
}

export interface PortableWorkerProfileReceipt {
    readonly component: 'master' | 'api'; readonly pid: number; readonly role: string;
    readonly state: 'saved' | 'disabled'; readonly file: string | null;
    readonly sha256?: string; readonly bytes?: number; readonly samples?: number; readonly durationMicros?: number;
}

/** Match real start/flush events to ordinary bounded files in that exact component directory. */
export async function auditPortableWorkerProfiles(output: string, component: 'master' | 'api', rows: readonly any[], enabled: boolean)
    : Promise<PortableWorkerProfileReceipt[]> {
    assert.ok(component === 'master' || component === 'api'); assert.equal(typeof enabled, 'boolean');
    const root = await realpath(await ordinaryPortablePath(output, true));
    const directory = await realpath(await ordinaryPortablePath(join(root, 'observer', component), true));
    const starts = rows.filter(row => row.kind === 'start');
    assert.ok(starts.length > 0 && starts.length <= portableWorkerProfileLimits.maximumProcesses, 'profile process census missing or excessive');
    const expected = new Set<string>(), pids = new Set<number>(); const receipts: PortableWorkerProfileReceipt[] = [];
    for (const start of starts) {
        assert.ok(Number.isSafeInteger(start.pid) && start.pid > 0 && !pids.has(start.pid), 'invalid or duplicated profile process');
        pids.add(start.pid); assert.ok(typeof start.role === 'string' && start.role.length > 0 && start.role.length <= 80);
        const flushes = rows.filter(row => row.kind === 'flush' && row.pid === start.pid);
        assert.equal(flushes.length, 1, `profile flush missing or duplicated: ${start.pid}`);
        const flush = flushes[0]; assert.equal(flush.success, true); assert.equal(flush.droppedRecords, 0);
        assert.equal(flush.profileState, enabled ? 'saved' : 'disabled', `profile state mismatch: ${start.pid}`);
        const started = rows.filter(row => row.kind === 'profile_started' && row.pid === start.pid);
        const saved = rows.filter(row => row.kind === 'profile_saved' && row.pid === start.pid);
        if (!enabled) {
            assert.equal(flush.profilePath, null, 'disabled profile returned a file');
            assert.equal(started.length, 0); assert.equal(saved.length, 0);
            receipts.push({component, pid: start.pid, role: start.role, state: 'disabled', file: null}); continue;
        }
        assert.equal(started.length, 1, 'CPU profile start evidence missing or duplicated');
        assert.equal(started[0].samplingIntervalMicros, portableWorkerProfileLimits.samplingIntervalMicros);
        assert.equal(started[0].maximumDurationMs, portableWorkerProfileLimits.maximumDurationMs);
        assert.equal(saved.length, 1, 'CPU profile save evidence missing or duplicated');
        const name = `worker-${start.pid}.cpuprofile`, path = join(directory, name); expected.add(name);
        assert.equal(typeof flush.profilePath, 'string');
        assert.equal(resolve(flush.profilePath), path, 'profile file belongs to another component or process');
        assert.equal(saved[0].profilePath, flush.profilePath, 'saved CPU profile does not match its flush');
        const bytes = await boundedPortableFile(path, portableWorkerProfileLimits.maximumBytes);
        assert.equal(saved[0].bytes, bytes.length, 'saved CPU profile size differs from its actual bytes');
        const profile = JSON.parse(bytes.toString('utf8'));
        assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0, 'CPU profile has no nodes');
        const ids = new Set<number>();
        for (const node of profile.nodes) {
            assert.ok(Number.isSafeInteger(node.id) && node.id > 0 && !ids.has(node.id), 'CPU profile node IDs are invalid'); ids.add(node.id);
            const frame = node.callFrame;
            assert.ok(frame && typeof frame === 'object' && typeof frame.functionName === 'string' && typeof frame.scriptId === 'string'
                && typeof frame.url === 'string' && Number.isSafeInteger(frame.lineNumber) && frame.lineNumber >= -1
                && Number.isSafeInteger(frame.columnNumber) && frame.columnNumber >= -1, 'CPU profile call frame is invalid');
        }
        const parents = new Set<number>();
        for (const node of profile.nodes) if (node.children !== undefined) {
            assert.ok(Array.isArray(node.children), 'CPU profile children are invalid');
            for (const child of node.children) {
                assert.ok(ids.has(child) && !parents.has(child), 'CPU profile call tree contains unknown or repeated children'); parents.add(child);
            }
        }
        const roots = profile.nodes.filter((node: any) => !parents.has(node.id));
        assert.equal(roots.length, 1, 'CPU profile must have one call-tree root');
        const nodes = new Map<number, any>(profile.nodes.map((node: any) => [node.id, node])), visited = new Set<number>(), pending = [roots[0].id];
        while (pending.length) {
            const id = pending.pop()!; assert.ok(!visited.has(id), 'CPU profile call tree is cyclic'); visited.add(id);
            for (const child of nodes.get(id).children ?? []) pending.push(child);
        }
        assert.equal(visited.size, ids.size, 'CPU profile call tree is disconnected or cyclic');
        assert.ok(Array.isArray(profile.samples) && profile.samples.length > 0 && profile.samples.every((id: unknown) => ids.has(id as number)),
            'CPU profile samples do not identify recorded nodes');
        assert.ok(Array.isArray(profile.timeDeltas) && profile.timeDeltas.length === profile.samples.length
            && profile.timeDeltas.every((value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0), 'CPU profile sample times are invalid');
        assert.ok(Number.isFinite(profile.startTime) && Number.isFinite(profile.endTime) && profile.startTime >= 0
            && profile.endTime > profile.startTime, 'CPU profile interval is invalid');
        receipts.push({component, pid: start.pid, role: start.role, state: 'saved', file: relative(root, path).replaceAll('\\', '/'),
            sha256: portableSourceHash(bytes), bytes: bytes.length, samples: profile.samples.length, durationMicros: profile.endTime - profile.startTime});
    }
    const actual = (await readdir(directory)).filter(name => name.endsWith('.cpuprofile')).sort();
    assert.deepEqual(actual, [...expected].sort(), 'unowned or unexpected CPU profile files');
    return receipts;
}
