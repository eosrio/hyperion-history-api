import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, readdir, realpath} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {actionHistoryImmutableJson} from '../history/action-history-manifest.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const artifacts = new Map<boolean, Promise<{codeRevision: string; executableSha256: string; pluginsSha256: string}>>();
async function tree(root: string, optional = false): Promise<Array<{path: string; sha256: string}>> {
    const members: Array<{path: string; sha256: string}> = []; let bytes = 0;
    const visit = async (directory: string) => {
        let entries;
        try {entries = await readdir(directory, {withFileTypes: true});} catch (error: any) {
            if (optional && directory === root && error?.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            const path = join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Admission artifact tree contains an unpinned symbolic link');
            if (entry.isDirectory()) {await visit(path); continue;}
            if (!entry.isFile() || !/\.(?:js|cjs|mjs|json|node|wasm|abi)$/.test(entry.name)) continue;
            const content = await readFile(path); bytes += content.length;
            if (members.length >= 10_000 || bytes > 512 * 1024 * 1024) throw new Error('Admission artifact hashing exceeds bounded startup budget');
            members.push({path: relative(root, path).split(sep).join('/'), sha256: hash(content)});
        }
    };
    await visit(root); return members;
}

/** Existing engineering inventory only: these fingerprints do not issue source or receipt authority. */
export async function installedRuntimeArtifacts(includeNativeCodec: boolean) {
    let pending = artifacts.get(includeNativeCodec);
    if (!pending) {pending = (async () => {
        const root = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
        const executableRoot = fileURLToPath(new URL('../../', import.meta.url));
        const revision = (await execute('git', ['rev-parse', 'HEAD'], {cwd: root, timeout: 5000, windowsHide: true})).stdout.trim();
        if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Admission qualification requires a source-revision build checkout');
        const executable = await tree(executableRoot);
        if (!executable.length) throw new Error('Admission executable inventory is empty');
        const lock = hash(await readFile(resolve(root, 'package-lock.json')));
        const plugins = await tree(resolve(root, 'plugins'), true);
        const nativeCodec = includeNativeCodec ? await tree(resolve(dirname(fileURLToPath(import.meta.resolve('@eosrio/node-abieos'))), '..')) : [];
        const sdk = await tree(resolve(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-sdk'))), '..'));
        return {codeRevision: revision, executableSha256: hash(actionHistoryImmutableJson({executable, nativeCodec, sdk, lock})),
            pluginsSha256: hash(actionHistoryImmutableJson({plugins, lock}))};
    })().catch(error => {artifacts.delete(includeNativeCodec); throw error;}); artifacts.set(includeNativeCodec, pending);}
    return pending;
}
