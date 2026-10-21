import {validateProjectionQuery, validateProjectionView, type ProjectionAdapter, type ProjectionDefinition,
    type ProjectionQueryResult, type ProjectionReadView} from '@eosrio/hyperion-sdk/projection';
import {portableStateBinding, type ResolvedPortableStateConfiguration} from './config.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

export interface PortableStateReadContext {
    readonly definition: ProjectionDefinition;
    readonly view: ProjectionReadView;
}
/** The source owner issues contexts only for initialized, canonically covered adapter checkpoints. */
export interface PortableStateReadGate {
    readReady(projectionId: string): Promise<PortableStateReadContext>;
    assertCurrent(context: PortableStateReadContext): Promise<void>;
}
export interface PortableStateQueryHost {
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
    adapter: ProjectionAdapter; gate: PortableStateReadGate}): PortableStateQueryHost {
    const definitions = new Map(options.configuration.projections.map(definition => [definition.id, definition]));
    return {async query(projectionId, input) {
        const definition = definitions.get(projectionId);
        if (!definition) throw new PortableStateQueryError(404, 'projection.not-configured', 'The requested projection is not configured.');
        const logical = validateProjectionQuery(definition, input);
        if (!logical.valid) throw new PortableStateQueryError(400, 'projection.invalid-contract',
            logical.errors.map(error => `${error.path}: ${error.message}`).join('; '));
        try {
            const context = await options.gate.readReady(projectionId);
            const validated = validateProjectionView(context.view);
            const binding = portableStateBinding(options.configuration, definition, options.chainId);
            if (!validated.valid || validated.value.checkpoint.blockNum < 1 || json(context.definition) !== json(definition)
                || json(validated.value.binding) !== json(binding)) unavailable();
            const view = validated.value;
            const result = await options.adapter.query(view, logical.value);
            const current = await options.adapter.open(binding);
            if (json(result.view) !== json(view) || json(current) !== json(view)) unavailable();
            await options.gate.assertCurrent(context);
            return result;
        } catch (error) {
            if (error instanceof PortableStateQueryError) throw error;
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                && /^[a-zA-Z0-9_.-]{1,96}$/.test(error.code) ? error.code : 'projection.query-unavailable';
            throw new PortableStateQueryError(503, code, 'The requested projection is unavailable; retry later.');
        }
    }};
}
