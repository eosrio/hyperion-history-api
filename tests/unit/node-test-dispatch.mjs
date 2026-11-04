import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Bun discovers .test.mjs files, but these fixtures require the CI Node runtime.
export function runNativeTests(fixture) {
  test(`native Node fixture: ${fileURLToPath(fixture)}`, {timeout: 240_000}, async () => {
    const node = process.env.HYPERION_NATIVE_NODE ?? (process.versions.bun ? 'node' : process.execPath);
    const guard = new URL('./node-test-runtime-guard.mjs', import.meta.url).href;
    const child = spawn(node, ['--import', guard, '--test', fileURLToPath(fixture)], {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {stdout += chunk;});
    child.stderr.on('data', chunk => {stderr += chunk;});
    const timeout = setTimeout(() => {timedOut = true; child.kill();}, 225_000);
    let spawnError;
    const result = await new Promise(resolve => {
      child.once('error', error => {spawnError = error;});
      child.once('close', (code, signal) => resolve({code, signal}));
    }).finally(() => clearTimeout(timeout));
    assert.ifError(spawnError);
    assert.deepEqual(result, {code: 0, signal: null}, `Node fixture failed${timedOut ? ' (deadline exceeded)' : ''}\n${stdout}\n${stderr}`);
  });
}
