import type {FastifyInstance} from 'fastify';

export type ProtocolProjection = 'contract-state' | 'native-permissions' | 'row-history' | 'action-filter';

export class ProtocolProjectionUnavailableError extends Error {
    readonly statusCode = 503;
    readonly code = 'protocol_projection_unavailable';
    readonly retryable = true;
    readonly headers = {'retry-after': '1'};
    constructor(readonly projection: ProtocolProjection) {
        super('The requested projection is not ready; retry later.');
        this.name = 'ProtocolProjectionUnavailableError';
    }
}

/** Legacy projections lack a qualified extension read view and canonical rollback.
 * A block-local ABI proof does not establish complete current state or query membership.
 * Replace this gate only with the projection runtime/adapter readiness contract.
 */
export function assertProtocolProjectionReady(fastify: FastifyInstance, projection: ProtocolProjection): void {
    if (fastify.manager.config.settings?.protocol?.provider === 'extension') {
        throw new ProtocolProjectionUnavailableError(projection);
    }
}

const projections: Readonly<Record<string, ProtocolProjection>> = {
    get_deltas: 'row-history',
    get_table_state: 'row-history',
    get_table_rows: 'contract-state',
    get_tokens: 'contract-state',
    get_top_holders: 'contract-state',
    get_voters: 'contract-state',
    get_proposals: 'contract-state',
    get_voter_scopes: 'contract-state',
    get_links: 'native-permissions',
    get_account: 'contract-state',
};

/** Check before response-cache access as well as the underlying projection query. */
export function assertProtocolRouteReady(fastify: FastifyInstance, route: string): void {
    if (Object.hasOwn(projections, route)) assertProtocolProjectionReady(fastify, projections[route]);
}
