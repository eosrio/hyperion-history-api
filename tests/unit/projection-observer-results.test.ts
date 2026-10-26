import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test.each(['projection-only', 'projection-and-fatal', 'sink-failure'])(
    'native projection diagnostics preserve original results: %s', async mode => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./projection-observer-results.mjs', import.meta.url)), mode],
        {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr}).toEqual({code: 0, stderr: ''});
        expect(JSON.parse(stdout)).toMatchObject({passed: true, mode, workerCases: 35, masterCases: 16,
            originalPromisesPreserved: true, baselinePlainGetterReads: 3, unhandledRejections: 0,
            controlledLocalOnly: true, productionAuthority: false, fullWorkerQualification: false});
    }, 20000);
