import {ProjectionContractError, type ProjectionAdapter} from '@eosrio/hyperion-sdk/projection';
import {portableStateBinding, type ResolvedPortableStateConfiguration} from './config.js';
import type {PortableStateReadContext, PortableStateReadGate} from './query-service.js';
import type {PortableProjectionSource} from './source.js';
import type {ProtocolAbiProofView} from '../protocol/abi-proof.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

/** Public reads attach to existing storage; only the projection worker may initialize it. */
export function createPortableStateReadGate(options: {chainId: string; configuration: ResolvedPortableStateConfiguration;
    adapter: ProjectionAdapter; source: Pick<PortableProjectionSource, 'open' | 'revalidate' | 'assertDefinition'>}): PortableStateReadGate {
    const issued = new WeakMap<PortableStateReadContext, ProtocolAbiProofView>();
    const same = (left: unknown, right: unknown) => protocolImmutableJson(left) === protocolImmutableJson(right);
    const unchanged = async (context: PortableStateReadContext) => {
        const proof = issued.get(context);
        if (!proof) throw new ProjectionContractError('projection.stale-view', 'Portable state context was not issued by this gate');
        const current = await options.adapter.open(context.view.binding);
        if (!same(current, context.view)) throw new ProjectionContractError('projection.stale-view', 'Portable state checkpoint changed');
        await options.source.revalidate(proof);
        await options.source.assertDefinition(proof, context.definition);
    };
    return {
        async readReady(projectionId) {
            const definition = options.configuration.projections.find(value => value.id === projectionId);
            if (!definition) throw new ProjectionContractError('projection.invalid-contract', 'Projection is not enabled');
            const binding = portableStateBinding(options.configuration, definition, options.chainId);
            const view = await options.adapter.open(binding);
            if (!same(view.binding, binding) || view.checkpoint.blockNum < 1)
                throw new ProjectionContractError('projection.incomplete', 'Projection has no covered initial source');
            const proof = await options.source.open(view.checkpoint);
            await options.source.assertDefinition(proof, definition);
            const context = Object.freeze({definition, view: Object.freeze({binding: Object.freeze({...view.binding}),
                checkpoint: Object.freeze({...view.checkpoint})})});
            issued.set(context, proof);
            await unchanged(context);
            return context;
        },
        assertCurrent: unchanged,
    };
}
