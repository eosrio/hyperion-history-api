import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {StreamActionsRequest} from '../../interfaces/stream-requests.js';
import {assertProtocolProjectionReady} from './protocol-state-readiness.js';

// These fields come from the trace envelope/receipt, independently of a contract ABI.
// Unknown plugin annotations and decoded paths require a qualified query-membership view.
const metadataFields = new Set([
    '_id', '_index', '_score', '@timestamp', 'timestamp', 'block_num', 'block_id', 'trx_id',
    'global_sequence', 'action_ordinal', 'creator_action_ordinal', 'parent', 'producer',
    'cpu_usage_us', 'net_usage_words', 'notified', 'act.account', 'act.name',
    'act.authorization.actor', 'act.authorization.permission', 'receipts.receiver',
    'receipts.global_sequence', 'receipts.recv_sequence', 'receipts.abi_sequence', 'receipts.code_sequence',
    'receipts.auth_sequence.account', 'receipts.auth_sequence.sequence',
]);

export function assertProtocolActionFieldsReady(fastify: FastifyInstance, fields: Iterable<string>): void {
    if (fastify.manager.config.settings?.protocol?.provider !== 'extension') return;
    for (const field of fields) {
        if (typeof field !== 'string') assertProtocolProjectionReady(fastify, 'action-filter');
        const nativeField = field.endsWith('.keyword') ? field.slice(0, -8) : field;
        if (!metadataFields.has(nativeField)) assertProtocolProjectionReady(fastify, 'action-filter');
    }
}

/** Check before cache access as well as action search construction. */
export function assertProtocolActionQueryReady(fastify: FastifyInstance, query: Record<string, unknown>): void {
    if (fastify.manager.config.settings?.protocol?.provider !== 'extension') return;
    const fields = Object.keys(query).filter(field => field.includes('.') || field.startsWith('@') || field === 'data');
    // Nested POST spellings must not turn a decoded predicate into an apparently empty query.
    for (const [field, value] of Object.entries(query)) {
        if (value !== null && typeof value === 'object') {
            const pending = [{field, value}];
            while (pending.length) {
                const entry = pending.pop()!;
                if (entry.field.split('.').length > 16) {
                    assertProtocolProjectionReady(fastify, 'action-filter');
                    break;
                }
                for (const [key, child] of Object.entries(entry.value)) {
                    const nestedField = `${entry.field}.${key}`;
                    if (child !== null && typeof child === 'object') pending.push({field: nestedField, value: child});
                    else fields.push(nestedField);
                }
            }
        }
    }
    if (typeof query.sortedBy === 'string') fields.push(query.sortedBy.split(':')[0]);
    assertProtocolActionFieldsReady(fastify, fields);
}

export function assertProtocolActionStreamReady(fastify: FastifyInstance, request: StreamActionsRequest): void {
    assertProtocolActionFieldsReady(fastify, (request.filters ?? []).map(filter => filter.field));
}

/** Endpoint-specific membership requirements apply even to already cached responses. */
export function assertProtocolActionRequestReady(fastify: FastifyInstance, request: FastifyRequest, route: string): void {
    if (fastify.manager.config.settings?.protocol?.provider !== 'extension') return;
    const query = request.query as Record<string, unknown>;
    if (route === 'get_actions') {
        const input = request.method === 'POST' ? request.body : query;
        assertProtocolActionQueryReady(fastify, typeof input === 'string' ? JSON.parse(input) : input as Record<string, unknown>);
    } else if (route === 'get_controlled_accounts'
        || (route === 'get_creator' && query.account !== (fastify.manager.config.settings.eosio_alias ?? 'eosio'))
        || (route === 'get_resource_usage' && query['@transfer.to'])) {
        assertProtocolProjectionReady(fastify, 'action-filter');
    }
}
