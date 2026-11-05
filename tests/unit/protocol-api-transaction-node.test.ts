import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('emitted HTTP proof transactions retain native Node async isolation, cancellation and one shared deadline', async () => {
    const node = process.env.HYPERION_NATIVE_NODE ?? Bun.which('node');
    if (!node) throw new Error('Native Node is required');
    const child = Bun.spawn([node, fileURLToPath(new URL('./protocol-api-transaction-node.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout}).toMatchObject({code: 0, stderr: ''});
    expect(stdout).toContain('"passed":true');
    expect(stdout).toContain('"emitted":true');
}, 20000);
