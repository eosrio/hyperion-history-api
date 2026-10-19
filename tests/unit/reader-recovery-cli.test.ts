import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

// Run each real command entrypoint and its original report/cleanup/status tail in
// a Node child. A load hook replaces only the expensive qualification cases with
// a completed workload; the isolated fake broker never opens a socket. This is
// CLI failure-propagation coverage, not another broker recovery qualification.
async function runCli(baseline: boolean, failure: 'none' | 'cleanup' | 'amqp') {
    const root = mkdtempSync(join(tmpdir(), 'hyperion-recovery-cli-'));
    const put = (relative: string, content: string | Buffer) => {
        const file = join(root, relative); mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, content);
    };
    const name = baseline ? 'reader-recovery-baseline.mjs' : 'reader-recovery.mjs';
    try {
        for (const script of ['reader-recovery.mjs', 'reader-recovery-baseline.mjs'])
            put('scripts/qualification/' + script, readFileSync(new URL('../../scripts/qualification/' + script, import.meta.url)));
        for (const file of ['src/indexer/helpers/reader-progress.ts', 'src/indexer/workers/state-reader.ts', 'src/indexer/modules/master.ts',
            'build/indexer/helpers/reader-progress.js', 'build/indexer/workers/state-reader.js', 'build/indexer/modules/master.js',
            'build/indexer/workers/state-reader.baseline.js', 'build/indexer/modules/master.baseline.js', 'package-lock.json'])
            put(file, '// isolated CLI status fixture; no production methods executed\n');
        put('node_modules/amqplib/package.json', JSON.stringify({type: 'module', exports: './index.mjs'}));
        put('node_modules/amqplib/index.mjs', `
            import {EventEmitter} from 'node:events';
            export async function connect(url) {
                if (url !== 'amqp://127.0.0.1:16555') throw new Error('Unexpected fixture target');
                const channel = new EventEmitter();
                channel.on = function (event, listener) {
                    EventEmitter.prototype.on.call(this, event, listener);
                    if (event === 'error' && process.env.CLI_FAILURE === 'amqp') this.emit('error', new Error('injected AMQP channel error'));
                    return this;
                };
                channel.close = async () => {if (process.env.CLI_FAILURE === 'cleanup') throw new Error('injected channel cleanup failure');};
                channel.deleteQueue = async () => ({});
                return Object.assign(new EventEmitter(), {createChannel: async () => channel, close: async () => {}});
            }
        `);
        put('node_modules/async/package.json', JSON.stringify({type: 'module', exports: './index.mjs'}));
        put('node_modules/async/index.mjs', `export function cargo() {throw new Error('Workload unexpectedly executed');}`);
        const target = pathToFileURL(join(root, 'scripts/qualification', name)).href;
        put('preload.mjs', `
            import assert from 'node:assert/strict';
            import childProcess from 'node:child_process';
            import {registerHooks, syncBuiltinESMExports} from 'node:module';
            childProcess.execFileSync = (command, args) => {
                if (command === 'git' && args[0] === 'show') return Buffer.from('// isolated historical source fixture');
                if (command === 'npm' && args.join(' ') === 'run build -- --noCheck') return Buffer.from('Isolated compiler fixture');
                throw new Error('Unexpected external command: ' + command);
            };
            syncBuiltinESMExports();
            registerHooks({load(url, context, nextLoad) {
                const loaded = nextLoad(url, context);
                if (url !== ${JSON.stringify(target)}) return loaded;
                const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString();
                const begin = ${JSON.stringify(baseline ? "        for (const mode of ['nack', 'lost']) {" : "        for (const mode of ['normal', 'nack', 'lost', 'channel', 'replace']) {")};
                const finish = ${JSON.stringify(baseline ? "        report.status = 'defects-reproduced';" : "        report.status = 'passed';")};
                assert.equal(source.split(begin).length, 2, 'Qualification case boundary changed');
                const start = source.indexOf(begin), end = source.indexOf(finish, start);
                assert(end > start);
                assert(!source.slice(start, end).includes('finally {\\n        for (const child of children)'));
                return {...loaded, source: source.slice(0, start) + '        report.cases.push({mode: "isolated-completed-workload"});\\n' + source.slice(end)};
            }});
        `);
        const node = process.env.READER_RECOVERY_NODE ?? Bun.which('node');
        expect(node).toBeTruthy();
        const child = Bun.spawn([node!, '--import', pathToFileURL(join(root, 'preload.mjs')).href, join(root, 'scripts/qualification', name), join(root, 'output')], {
            cwd: root, env: {...process.env, READER_RECOVERY_AMQP_URL: 'amqp://127.0.0.1:16555', READER_RECOVERY_RUN: 'cli-status-fixture', CLI_FAILURE: failure},
            stdout: 'pipe', stderr: 'pipe'
        });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(stderr).toBe('');
        const report = JSON.parse(readFileSync(join(root, 'output/report.json'), 'utf8'));
        expect(report.cases).toEqual([{mode: 'isolated-completed-workload'}]);
        expect(report.cleanup.childProcessesRemaining).toBe(0);
        expect(JSON.parse(stdout).status).toBe(report.status);
        return {code, report};
    } finally {
        if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'hyperion-recovery-cli-')) throw new Error('Unsafe test cleanup target');
        rmSync(root, {recursive: true, force: true});
    }
}

for (const baseline of [false, true]) {
    const label = baseline ? 'baseline recovery CLI' : 'fixed recovery CLI';
    test(`${label} exits nonzero after cleanup changes its completed report to failed`, async () => {
        const {code, report} = await runCli(baseline, 'cleanup');
        expect(report.status).toBe('failed'); expect(report.cleanup.errors).toContain('injected channel cleanup failure');
        expect(code).toBe(1);
    });
    test(`${label} retains exit zero for its successful report`, async () => {
        const {code, report} = await runCli(baseline, 'none');
        expect(report.status).toBe(baseline ? 'defects-reproduced' : 'passed'); expect(report.cleanup.errors).toEqual([]);
        expect(code).toBe(0);
    });
}
test('fixed recovery CLI exits nonzero for a recorded AMQP error after the workload completes', async () => {
    const {code, report} = await runCli(false, 'amqp');
    expect(report.status).toBe('failed'); expect(report.cleanup.errors).toEqual([]);
    expect(report.amqpErrors).toEqual([{source: 'oracle-channel', error: 'injected AMQP channel error'}]);
    expect(code).toBe(1);
});
