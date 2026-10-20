import type {FastifyInstance} from 'fastify';
import {resolvePortableStateConfiguration} from '../../indexer/projection/config.js';
import {createPortableStateBackend} from '../../indexer/projection/backend.js';
import {createPortableStateQueryService, PortableStateQueryError, type PortableStateQueryHost} from '../../indexer/projection/query-service.js';
import {loadChainProtocol} from '../../indexer/protocol/selection.js';
import {PortableProjectionSource} from '../../indexer/projection/source.js';
import {createPortableStateReadGate} from '../../indexer/projection/production.js';

/** API startup attaches read-only consumers; the existing projection worker owns initialization and durable progress. */
export async function createPortableStateApiService(fastify: FastifyInstance): Promise<PortableStateQueryHost | undefined> {
    const manager = fastify.manager;
    const chainId = manager.conn.chains[manager.chain].chain_id;
    const configuration = resolvePortableStateConfiguration(manager.config.features.portable_state, chainId);
    if (!configuration) return undefined;
    if (!manager.mongodbClient || manager.config.settings.protocol?.provider !== 'extension') {
        throw new PortableStateQueryError(503, 'projection.capability-unavailable', 'Portable state requires MongoDB and a selected certified protocol provider.');
    }
    const selected = await loadChainProtocol(manager.config.settings.protocol);
    const adapter = createPortableStateBackend(manager.mongodbClient, configuration);
    const source = new PortableProjectionSource({client: manager.elasticsearchClient, chain: manager.chain, chainId,
        profile: {id: selected.id, profileId: selected.provider.profileId, components: selected.components ?? []}, provider: selected.provider,
        maxAncestryBlocks: manager.config.settings.protocol_abi_coordination?.recovery_window_blocks,
        replicas: manager.config.settings.es_replicas ?? 0});
    return createPortableStateQueryService({chainId, configuration, adapter,
        gate: createPortableStateReadGate({chainId, configuration, adapter, source})});
}
