import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('the actual armed projection preload installs its Mongo observer on the selected native runtime', async () => {
    const observer = new URL('../../scripts/qualification/portable-state-recovery-observer.mjs', import.meta.url).href;
    const driver = `
        import assert from 'node:assert/strict';
        import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
        import {tmpdir} from 'node:os';
        import {dirname, join} from 'node:path';
        import {MongoClient} from 'mongodb';
        const root = realpathSync(tmpdir()), directory = realpathSync(mkdtempSync(join(root, 'hapi-recovery-observer-')));
        const actualPlatform = process.platform, originalConnect = MongoClient.prototype.connect;
        try {
            writeFileSync(join(directory, 'arm.json'), JSON.stringify({database: 'h45_p191_123456abcdef', metadataId: 'a'.repeat(64)}), {flag: 'wx'});
            process.env.worker_role = 'projection'; process.env.HYP246_RECOVERY_OBSERVER = directory;
            // Windows can verify the armed preload component, without claiming Linux signal behavior.
            if (actualPlatform === 'win32') {
                await assert.rejects(import(${JSON.stringify(observer + '?unsupported-platform')}), /requires Linux/);
                assert.equal(MongoClient.prototype.connect, originalConnect);
                Object.defineProperty(process, 'platform', {value: 'linux'});
            }
            await import(${JSON.stringify(observer)});
            assert.notEqual(MongoClient.prototype.connect, originalConnect);
            console.log(JSON.stringify({node: process.version, actualPlatform, wrapperInstalled: true,
                mongoConnectCalled: false, signalSent: false, linuxRecoveryQualified: false}));
        } finally {
            assert.equal(dirname(directory), root); rmSync(directory, {recursive: true, force: true});
        }
    `;
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--input-type=module', '-e', driver],
        {cwd: fileURLToPath(new URL('../../', import.meta.url)), stdout: 'pipe', stderr: 'pipe', timeout: 10_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout)).toMatchObject({wrapperInstalled: true, mongoConnectCalled: false, signalSent: false, linuxRecoveryQualified: false});
});
