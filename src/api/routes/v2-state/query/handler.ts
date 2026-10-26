import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {validateProjectionQueryInput} from '@eosrio/hyperion-sdk/projection';
import {PortableStateQueryError} from '../../../../indexer/projection/query-service.js';
import {protocolImmutableJson} from '../../../../indexer/protocol/immutable-bundle-store.js';
import {stateResponseHeaders} from '../../../helpers/state-headers.js';

export function validatePortableStateQueryBody(input: unknown): {projection: string; query: unknown} {
    let body: any;
    try {body = JSON.parse(protocolImmutableJson(input, 2 * 1024 * 1024));}
    catch {throw new PortableStateQueryError(400, 'projection.invalid-contract', 'Expected a bounded logical projection query.');}
    const query = validateProjectionQueryInput(body?.query);
    if (!body || Array.isArray(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'projection')
        || !Object.hasOwn(body, 'query') || typeof body.projection !== 'string' || !body.projection.length
        || body.projection.length > 128 || !body.projection.isWellFormed() || !query.valid) {
        throw new PortableStateQueryError(400, 'projection.invalid-contract', 'Expected projection and a logical equality/keyset query.');
    }
    return {projection: body.projection, query: query.value};
}

export function portableStateQueryHandler(fastify: FastifyInstance) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header('cache-control', 'no-store');
        try {
            const body = validatePortableStateQueryBody(request.body);
            const host = fastify.portableState;
            if (!host) throw new PortableStateQueryError(503, 'projection.query-unavailable', 'Portable state is unavailable; retry later.');
            const finality = host.finality;
            const result = await host.query(body.projection, body.query);
            reply.headers(stateResponseHeaders(result.view, finality)).send(result);
        } catch (error) {
            const failure = error instanceof PortableStateQueryError ? error
                : new PortableStateQueryError(503, 'projection.query-unavailable', 'Portable state is unavailable; retry later.');
            if (failure.retryable) reply.header('retry-after', '1');
            reply.code(failure.statusCode).send({code: failure.code, message: failure.message,
                statusCode: failure.statusCode, retryable: failure.retryable});
        }
    };
}
