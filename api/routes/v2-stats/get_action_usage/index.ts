import {FastifyInstance} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions";
import {getActionUsageHandler} from "./get_action_usage";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get action and transaction stats for a given period',
        summary: 'get action and transaction stats for a given period',
        tags: ['stats'],
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
                }
            }
        }
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getActionUsageHandler,
        schema
    );
    next();
}