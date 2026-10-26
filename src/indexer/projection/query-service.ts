import {validateProjectionQuery, validateProjectionView, validateProjectionRollbackView,
    type ProjectionAdapter, type ProjectionRollbackAdapter, type ProjectionRollbackReadView, type ProjectionDefinition,
    type ProjectionBinding, type ProjectionQuery, type ProjectionQueryResult, type ProjectionReadView} from '@eosrio/hyperion-sdk/projection';
import {portableStateBinding, type PortableStateFinality, type ResolvedPortableStateConfiguration} from './config.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

export interface PortableStateReadContext {
    readonly definition: ProjectionDefinition;
    readonly view: ProjectionReadView | ProjectionRollbackReadView;
    readonly finality: PortableStateFinality;
}
export type PortableStateReadableAdapter = Pick<ProjectionAdapter, 'capabilities' | 'open' | 'query'>
    | Pick<ProjectionRollbackAdapter, 'capabilities' | 'open' | 'query'>;
const rollbackBackend = (adapter: PortableStateReadableAdapter): adapter is Pick<ProjectionRollbackAdapter, 'capabilities' | 'open' | 'query'> =>
    adapter.capabilities.interfaceVersion === 2;
/** The source owner issues contexts only for initialized, canonically covered adapter checkpoints. */
export interface PortableStateReadGate {
    readReady(projectionId: string): Promise<PortableStateReadContext>;
    assertCurrent(context: PortableStateReadContext): Promise<void>;
}
export interface PortableStateQueryHost {
    readonly finality?: PortableStateFinality;
    query(projectionId: string, query: unknown): Promise<ProjectionQueryResult>;
}
export class PortableStateQueryError extends Error {
    constructor(readonly statusCode: 400 | 404 | 503, readonly code: string, message: string,
                readonly retryable = statusCode === 503) {super(message); this.name = 'PortableStateQueryError';}
}
const json = (value: unknown) => protocolImmutableJson(value);
function unavailable(): never {
    throw new PortableStateQueryError(503, 'projection.query-unavailable', 'The requested projection is unavailable; retry later.');
}

/** HTTP and future domain plugins share this logical query boundary, never a native database handle. */
export function createPortableStateQueryService(options: {chainId: string; configuration: ResolvedPortableStateConfiguration;
    adapter: PortableStateReadableAdapter; gate: PortableStateReadGate}): PortableStateQueryHost {
    const definitions = new Map(options.configuration.projections.map(definition => [definition.id, definition]));
    return {finality: options.configuration.finality, async query(projectionId, input) {
        const definition = definitions.get(projectionId);
        if (!definition) throw new PortableStateQueryError(404, 'projection.not-configured', 'The requested projection is not configured.');
        const logical = validateProjectionQuery(definition, input);
        if (!logical.valid) throw new PortableStateQueryError(400, 'projection.invalid-contract',
            logical.errors.map(error => `${error.path}: ${error.message}`).join('; '));
        try {
            const context = await options.gate.readReady(projectionId);
            const binding = portableStateBinding(options.configuration, definition, options.chainId);
            if (json(context.definition) !== json(definition) || context.finality !== options.configuration.finality) unavailable();
            const execute = async <View extends ProjectionReadView>(adapter: {
                open(binding: ProjectionBinding): Promise<View>;
                query(view: View, query: ProjectionQuery): Promise<ProjectionQueryResult>;
            }, view: View) => {
                if (view.checkpoint.blockNum < 1 || json(view.binding) !== json(binding)) unavailable();
                const result = await adapter.query(view, logical.value);
                const current = await adapter.open(binding);
                if (json(result.view) !== json(view) || json(current) !== json(view)) unavailable();
                await options.gate.assertCurrent(context);
                return result;
            };
            const backend = options.adapter;
            if (rollbackBackend(backend)) {
                const validated = validateProjectionRollbackView(context.view);
                if (!validated.valid) unavailable();
                return await execute(backend, validated.value);
            }
            const validated = validateProjectionView(context.view);
            if (!validated.valid) unavailable();
            return await execute(backend, validated.value);
        } catch (error) {
            if (error instanceof PortableStateQueryError) throw error;
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                && /^[a-zA-Z0-9_.-]{1,96}$/.test(error.code) ? error.code : 'projection.query-unavailable';
            throw new PortableStateQueryError(503, code, 'The requested projection is unavailable; retry later.');
        }
    }};
}
