import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['registry', 'routing']) {
    test(`master replacements preserve the Node worker registry and ${mode} behavior`, async () => {
        const node = process.env.WORKER_REGISTRY_NODE ?? Bun.which('node');
        if (!node) throw new Error('Native Node.js is required for the cluster registry regression');
        const child = Bun.spawn([node, fileURLToPath(new URL('./worker-registry-fixture.mjs', import.meta.url)), `--${mode}`],
            {stdout: 'pipe', stderr: 'pipe', timeout: 20000});
        const [code, stdout, stderr] = await Promise.all([child.exited,
            new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
        expect(stdout).toContain(`"passed":true,"mode":"${mode}","replacements":6`);
    }, 25000);
}
