import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, readdir, realpath} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {actionHistoryImmutableJson, type ActionHistoryBlockPlan} from './action-history-manifest.js';
import type {HyperionWorker} from '../workers/hyperionWorker.js';
import type {HyperionConfig} from '../../interfaces/hyperionConfig.js';
import type {Filters} from '../modules/config.js';
import type {ActionSourceInventoryPolicy} from './action-source-inventory.js';

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
async function installedArtifacts(includeNativeCodec: boolean) {
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
export function actionConfigurationSnapshot(config: HyperionConfig, filters: Filters, handlers: unknown): string {
    return actionHistoryImmutableJson({config, filters: {
        actionBlacklist: [...filters.action_blacklist].sort(), actionWhitelist: [...filters.action_whitelist].sort(),
        deltaBlacklist: [...filters.delta_blacklist].sort(), deltaWhitelist: [...filters.delta_whitelist].sort()}, handlers});
}
export function currentActionConfiguration(worker: HyperionWorker): string {
    return actionConfigurationSnapshot(worker.conf, worker.filters, worker.mLoader.snapshotActionHandlers());
}
export function currentActionPolicy(worker: HyperionWorker): ActionSourceInventoryPolicy {
    if (worker.conf.settings.parser !== '3.2' || worker.mLoader.parser?.flatten) throw new Error('Unsupported admission parser/grouping policy');
    return Object.freeze({schemaVersion: 1, parserVersion: '3.2',
        actionBlacklist: Object.freeze([...worker.filters.action_blacklist].sort()),
        actionWhitelist: Object.freeze([...worker.filters.action_whitelist].sort()),
        rootOnly: !!worker.conf.whitelists.root_only && !!(worker.conf.whitelists.actions?.length || worker.conf.whitelists.deltas?.length),
        maxDepth: worker.conf.whitelists.max_depth || 0, maxInline: worker.conf.indexer.max_inline || 0,
        eosioAlias: worker.conf.settings.eosio_alias || 'eosio'});
}
export async function actionProducerEpoch(worker: HyperionWorker): Promise<{
    producer: ActionHistoryBlockPlan['producer']; executableSha256: string; configuration: string; policy: ActionSourceInventoryPolicy
}> {
    const configuration = currentActionConfiguration(worker), policy = currentActionPolicy(worker);
    const build = await installedArtifacts(!worker.usesExtensionProtocol);
    if (currentActionConfiguration(worker) !== configuration) throw new Error('Action producer configuration changed during admission');
    return {configuration, policy, executableSha256: build.executableSha256, producer: {
        protocolId: worker.protocolId, profileId: worker.protocol.profileId, codeRevision: build.codeRevision,
        configurationSha256: hash(configuration), pluginsSha256: hash(actionHistoryImmutableJson({
            installed: build.pluginsSha256, components: worker.protocolComponents ?? [], handlers: worker.mLoader.snapshotActionHandlers()}))}};
}
