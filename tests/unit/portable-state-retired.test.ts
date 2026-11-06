import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {HyperionConfigSchema} from '../../src/interfaces/hyperionConfig.js';

const message = 'features.portable_state was removed; use features.stateful_owner_v2';
const loader = pathToFileURL(join(import.meta.dir, '../../build/indexer/modules/config.js')).href;

/** The actual runtime loader in a separate process, because a failed load ends that process. */
async function load(features: Record<string, unknown>) {
    const directory = mkdtempSync(join(tmpdir(), 'hyperion-retired-state-'));
    try {
        mkdirSync(join(directory, 'config'));
        writeFileSync(join(directory, 'config/connections.json'), '{}');
        const file = join(directory, 'chain.json');
        writeFileSync(file, JSON.stringify({settings: {chain: 'retired-state'}, indexer: {}, features, whitelists: {}, blacklists: {}}));
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--input-type=module', '-e',
            `const {ConfigurationModule} = await import(${JSON.stringify(loader)}); new ConfigurationModule(); console.log('loaded');`],
        {cwd: directory, env: {...process.env, CONFIG_JSON: file}, stdout: 'pipe', stderr: 'pipe', timeout: 15000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return {code, stdout, stderr};
    } finally {rmSync(directory, {recursive: true, force: true});}
}

test('a stale portable_state key stops the actual config loader instead of being ignored', async () => {
    const stale = await load({portable_state: {backend: {kind: 'mongodb', id: 'state', database: 'state'}, projections: []}});
    expect(stale.code).not.toBe(0);
    expect(stale.stdout).not.toContain('loaded');
    expect(stale.stdout + stale.stderr).toContain(message);
});

test('the same configuration loads without the key', async () => {
    const clean = await load({});
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('loaded');
});

test('the configuration CLI schema rejects the key with the same guidance', () => {
    const slot = HyperionConfigSchema.shape.features.shape.portable_state;
    expect(slot.safeParse(undefined).success).toBe(true);
    const result = slot.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
});
