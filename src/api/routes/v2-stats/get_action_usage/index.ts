import {FastifyInstance} from "fastify";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import {getActionUsageHandler} from "./get_action_usage.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get action and transaction stats for a given period',
        summary: 'get action and transaction stats for a given period',
        tags: ['stats'],
        response: extendResponseSchema({
            action_count: {type: 'string', pattern: '^(0|[1-9][0-9]*)$', description: 'Exact decimal action count'},
            tx_count: {type: 'number'},
            unique_actors: {type: 'number'},
            period: {type: 'string'},
            from: {type: 'string'},
            to: {type: 'string'},
            cache_exp: {type: 'number'}
        }),
        querystring: {
            type: 'object',
            required: ["period"],
            properties: {
                "period": {
                    description: 'analysis period',
                    type: 'string'
                },
                "end_date": {
                    description: 'final date',
                    type: 'string'
                },
                "unique_actors": {
                    description: 'compute unique actors',
                    type: 'boolean'
                }
            }
        }
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        getActionUsageHandler,
        schema
    );
    next();
}
