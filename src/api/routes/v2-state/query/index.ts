import type {FastifyInstance} from 'fastify';
import {portableStateQueryHandler, validatePortableStateQueryBody} from './handler.js';

export default function (fastify: FastifyInstance, _options: unknown, next: () => void) {
    fastify.route({method: 'POST', url: '/query', bodyLimit: 2 * 1024 * 1024,
        onRequest: async (_request, reply) => {reply.header('cache-control', 'no-store');},
        schema: {tags: ['state'], summary: 'Query a configured portable state projection', body: {
            type: 'object', required: ['projection', 'query'], additionalProperties: false,
            properties: {projection: {type: 'string', minLength: 1, maxLength: 128}, query: {type: 'object'}},
        }},
        // Fastify's default AJV removes unknown fields. Reject them without altering the logical request.
        validatorCompiler: () => data => {
            try {return {value: validatePortableStateQueryBody(data)};}
            catch (error) {return {error: error as Error};}
        },
        handler: portableStateQueryHandler(fastify)});
    next();
}
