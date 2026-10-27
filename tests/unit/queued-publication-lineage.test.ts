import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

for (const scenario of ['held','changed-payload','changed-headers','changed-queue','foreign','source-fence',
    'duplicate','overlap','redelivery','fenced-overlap','registration-rebind','publication-bound','delivery-bound',
    'mutate-payload','mutate-headers','fence-before-send','replace-before-send','late-return','channel-close',
    'unknown-send','retry','disabled']) {
    test(`original managed Wire publication lineage: ${scenario}`, async () => {
        const process = Bun.spawn([Bun.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./queued-publication-native.mjs', import.meta.url)), scenario],
        {stdout: 'pipe', stderr: 'pipe', timeout: 35_000});
        const [code, stdout, stderr] = await Promise.all([process.exited,
            new Response(process.stdout).text(), new Response(process.stderr).text()]);
        const evidence = Bun.env.HYPERION_QUEUED_LINEAGE_EVIDENCE;
        if (evidence) {
            mkdirSync(evidence, {recursive: true});
            writeFileSync(join(evidence, `${scenario}.stdout`), stdout);
            writeFileSync(join(evidence, `${scenario}.stderr`), stderr);
        }
        expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
        const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
        expect(result).toMatchObject({passed: true, scenario, actualManagedMainDsRoute: true, fullCapacityQualification: false});
        if (scenario === 'disabled') expect(result.lineage).toBeUndefined();
        else {
            expect(result.lineage).toMatchObject({observationOnly: true, capacityReleased: false});
            for (const publication of result.lineage.publications) expect(publication.brokerSettlement).toBe('unknown');
        }
    }, 40_000);
}
