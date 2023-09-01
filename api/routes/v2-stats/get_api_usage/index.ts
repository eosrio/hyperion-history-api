import {FastifyInstance} from "fastify";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions";
import {getApiUsageHandler} from "./get_api_usage";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get hyperion api usage statistics',
        summary: 'get hyperion api usage statistics',
        tags: ['stats'],
        response: extendResponseSchema({
            total: {
                type: 'object',
                properties: {
                    responses: {
                        additionalProperties: true
                    }
                }
            },
            buckets: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        timestamp: {type: 'string'},
                        responses: {
                            additionalProperties: true
                        }
                    }
                }
            }
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getApiUsageHandler,
        schema
    );
    next();
}
