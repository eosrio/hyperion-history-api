import {FastifyInstance} from "fastify";
import {getVotersHandler} from "./get_voters.js";
import {addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get voters',
        summary: 'get voters',
        tags: ['system'],
        querystring: extendQueryStringSchema({
            "producer": {
                description: 'filter by voted producer (comma separated)',
                type: 'string',
                minLength: 1,
                maxLength: 12
            }
        }),
        response: extendResponseSchema({
            voter_count: {
                type: "integer"
            },
            voters: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        account: {type: "string"},
                        weight: {type: "number"},
                        last_vote: {type: "number"},
                        data: {
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
        getRouteName(import.meta.filename),
        getVotersHandler,
        schema
    );
    next();
}
