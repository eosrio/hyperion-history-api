import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
import {assertSuccessfulWorkerShutdown} from '../../scripts/qualification/es955-workers.ts';
import {auditWorkerRejectionDiagnostics} from '../../scripts/qualification/worker-rejection-diagnostics.mjs';

test('native worker rejection provenance retains original decisions, custody, real forks and reader exit failures', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./worker-rejection-provenance.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 45000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr}).toEqual({code: 0, stderr: ''});
    const result = JSON.parse(stdout.trim());
    expect(result.status).toBe('passed'); expect(result.checks).toBe(31); expect(result.rows).toBe(39);
}, 50000);

test('diagnostic copies cannot normalize failed shutdowns, extra deaths or a nonzero master exit', () => {
    const raw = [{kind: 'shutdown', pid: 100, success: false, forced: [], unresolved: [], failedChildren: [101]},
        {kind: 'native_boundary', event: 'action_admission_rejected', pid: 101, observationOnly: true,
            predicate: 'producer_epoch', parentIncarnation: 'copied-stale-incarnation'},
        {kind: 'worker_exit', pid: 100, childPid: 101, code: 1, signal: null}];
    const preserved = structuredClone(raw);
    expect(() => assertSuccessfulWorkerShutdown(raw, 100, 1, null)).toThrow('master process did not exit successfully');
    expect(() => assertSuccessfulWorkerShutdown(raw, 100, 0, null)).toThrow('full-worker shutdown did not complete cleanly');
    expect(raw).toEqual(preserved);
    const normal = [{kind: 'shutdown', pid: 100, success: true, forced: [], unresolved: [], failedChildren: [],
        childExits: [{pid: 101, code: 0, signal: null}]},
        {kind: 'worker_fork', pid: 100, childPid: 101}, {kind: 'worker_exit', pid: 100, childPid: 101, code: 0, signal: null},
        {kind: 'start', pid: 100}, {kind: 'start', pid: 101}, {kind: 'exit', pid: 100, code: 0}, {kind: 'exit', pid: 101, code: 0}, raw[1]];
    expect(assertSuccessfulWorkerShutdown(normal, 100, 0, null).success).toBe(true);
    const extra = [...normal, {kind: 'worker_exit', pid: 100, childPid: 102, code: 1, signal: null}];
    expect(() => assertSuccessfulWorkerShutdown(extra, 100, 0, null)).toThrow('parent-observed child exits incomplete');
    const unrelated = normal.map(row => row.kind === 'worker_exit' ? {...row, code: 1} : row);
    expect(() => assertSuccessfulWorkerShutdown(unrelated, 100, 0, null)).toThrow('child process failed: 101');
    expect(raw).toEqual(preserved);
});

test('capture failures, omitted decisions and changed limits fail the diagnostic audit independently of raw shutdown', () => {
    const row = {kind: 'native_boundary', event: 'observer_metrics', pid: 101, rejectionDiagnostics: {
        observationOnly: true, maximumRejections: 32, maximumPendingPublications: 64, maximumWorkers: 256,
        reportFailures: 0, omittedRejections: 0}};
    expect(auditWorkerRejectionDiagnostics([row])).toHaveLength(1);
    expect(() => auditWorkerRejectionDiagnostics([{...row, rejectionDiagnostics: {...row.rejectionDiagnostics, reportFailures: 1}}])).toThrow('capture failed');
    expect(() => auditWorkerRejectionDiagnostics([{...row, rejectionDiagnostics: {...row.rejectionDiagnostics, omittedRejections: 1}}])).toThrow('omitted');
    expect(() => auditWorkerRejectionDiagnostics([{...row, rejectionDiagnostics: {...row.rejectionDiagnostics, maximumRejections: 33}}])).toThrow();
    expect(() => auditWorkerRejectionDiagnostics([row, structuredClone(row)])).toThrow('Duplicated');
    expect(() => auditWorkerRejectionDiagnostics([{...row, rejectionDiagnostics: undefined}])).toThrow('unavailable');
});

test.each([['--record-limit', 34, 32], ['--byte-limit', 1, 0]])('native %s exhaustion preserves every original rejection', async (mode, checks, rows) => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./worker-rejection-provenance.mjs', import.meta.url)), String(mode)],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr}).toEqual({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim())).toMatchObject({status: 'passed', checks, rows});
}, 20000);
