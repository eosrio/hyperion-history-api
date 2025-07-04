import { FastifyInstance } from 'fastify';
import { getVotersHandler } from './get_voters.js';
import { addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName } from '../../../helpers/functions.js';

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get voters',
        summary: 'get voters',
        tags: ['system'],
        querystring: extendQueryStringSchema({
            producer: {
                description: 'filter by voted producer (comma separated)',
                type: 'string',
                minLength: 1
            }
        }),
        response: extendResponseSchema({
            voter_count: {
                type: 'integer'
            },
            error: {
                type: 'string',
                description: 'Error message when a condition fails (MongoDB disabled or feature disabled)'
            },
            voters: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        account: { type: 'string' },
                        is_proxy: { type: 'boolean' },
                        weight: { type: 'number' },
                        staked: { type: 'number' },
                        last_vote_block: { type: 'number' },
                        producers: {
                            type: 'array',
                            items: {
                                type: 'string'
                            }
                        }
                    }
                }
            }
        })
    };
    addApiRoute(fastify, 'GET', getRouteName(import.meta.filename), getVotersHandler, schema);
    next();
}
