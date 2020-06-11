import {FastifyInstance} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions";
import {getResourceUsageHandler} from "./get_resource_usage";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get resource usage stats for a specific action',
        summary: 'get resource usage stats for a specific action',
        tags: ['stats'],
        querystring: {
            type: 'object',
            required: ["code", "action"],
            properties: {
                "code": {
                    description: 'contract',
                    type: 'string'
                },
                "action": {
                    description: 'action name',
                    type: 'string'
                }
            }
        }
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getResourceUsageHandler,
        schema
    );
    next();
}
