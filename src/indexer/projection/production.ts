import {ProjectionContractError, validateProjectionRollbackView, validateProjectionView} from '@eosrio/hyperion-sdk/projection';
import {portableStateBinding, type ResolvedPortableStateConfiguration} from './config.js';
import type {PortableStateReadContext, PortableStateReadGate, PortableStateReadableAdapter} from './query-service.js';
import type {PortableProjectionSource, PortableProjectionSourceState} from './source.js';
import type {ProtocolAbiProofView} from '../protocol/abi-proof.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

/** Public reads attach to existing storage; only the projection worker may initialize it. */
export function createPortableStateReadGate(options: {chainId: string; configuration: ResolvedPortableStateConfiguration;
    adapter: PortableStateReadableAdapter; source: Pick<PortableProjectionSource, 'open' | 'revalidate' | 'assertDefinition'>
        & Partial<Pick<PortableProjectionSource, 'openState' | 'assertState'>>}): PortableStateReadGate {
    const stateSource = typeof options.source.openState === 'function' && typeof options.source.assertState === 'function';
    if ((options.adapter.capabilities.interfaceVersion === 2 || options.configuration.finality === 'irreversible') && !stateSource)
        throw new ProjectionContractError('projection.capability-unavailable', 'Canonical state finality validation is required');
    const issued = new WeakMap<PortableStateReadContext, {kind: 'legacy'; proof: ProtocolAbiProofView}
        | {kind: 'state'; state: PortableProjectionSourceState}>();
    const same = (left: unknown, right: unknown) => protocolImmutableJson(left) === protocolImmutableJson(right);
    const unchanged = async (context: PortableStateReadContext) => {
        const authority = issued.get(context);
        if (!authority || context.finality !== options.configuration.finality)
            throw new ProjectionContractError('projection.stale-view', 'Portable state context was not issued by this gate');
        const current = await options.adapter.open(context.view.binding);
        if (!same(current, context.view)) throw new ProjectionContractError('projection.stale-view', 'Portable state checkpoint changed');
        if (authority.kind === 'state') await options.source.assertState!(authority.state, context.definition);
        else {
            await options.source.revalidate(authority.proof);
            await options.source.assertDefinition(authority.proof, context.definition);
        }
    };
    return {
        async readReady(projectionId) {
            const definition = options.configuration.projections.find(value => value.id === projectionId);
            if (!definition) throw new ProjectionContractError('projection.invalid-contract', 'Projection is not enabled');
            const binding = portableStateBinding(options.configuration, definition, options.chainId);
            const input = await options.adapter.open(binding);
            const validated = options.adapter.capabilities.interfaceVersion === 2
                ? validateProjectionRollbackView(input) : validateProjectionView(input);
            if (!validated.valid) throw new ProjectionContractError('projection.incomplete', 'Invalid portable state read view');
            const view = validated.value;
            if (!same(view.binding, binding) || view.checkpoint.blockNum < 1)
                throw new ProjectionContractError('projection.incomplete', 'Projection has no covered initial source');
            const context = Object.freeze({definition, view, finality: options.configuration.finality});
            if (stateSource) {
                const state = await options.source.openState!(view.checkpoint, options.configuration.finality);
                if (!same(state.checkpoint, view.checkpoint) || state.finality !== options.configuration.finality)
                    throw new ProjectionContractError('projection.incomplete', 'Canonical source state differs from this requested view');
                await options.source.assertState!(state, definition);
                issued.set(context, {kind: 'state', state});
            } else {
                const proof = await options.source.open(view.checkpoint);
                await options.source.assertDefinition(proof, definition);
                issued.set(context, {kind: 'legacy', proof});
            }
            await unchanged(context);
            return context;
        },
        assertCurrent: unchanged,
    };
}
