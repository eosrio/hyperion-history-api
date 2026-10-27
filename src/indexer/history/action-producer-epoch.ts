import {createHash} from 'node:crypto';
import {installedRuntimeArtifacts} from '../helpers/runtime-artifacts.js';
import {actionHistoryImmutableJson, type ActionHistoryBlockPlan} from './action-history-manifest.js';
import type {HyperionWorker} from '../workers/hyperionWorker.js';
import type {HyperionConfig} from '../../interfaces/hyperionConfig.js';
import type {Filters} from '../modules/config.js';
import type {ActionSourceInventoryPolicy} from './action-source-inventory.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
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
    const build = await installedRuntimeArtifacts(!worker.usesExtensionProtocol);
    if (currentActionConfiguration(worker) !== configuration) throw new Error('Action producer configuration changed during admission');
    return {configuration, policy, executableSha256: build.executableSha256, producer: {
        protocolId: worker.protocolId, profileId: worker.protocol.profileId, codeRevision: build.codeRevision,
        configurationSha256: hash(configuration), pluginsSha256: hash(actionHistoryImmutableJson({
            installed: build.pluginsSha256, components: worker.protocolComponents ?? [], handlers: worker.mLoader.snapshotActionHandlers()}))}};
}
