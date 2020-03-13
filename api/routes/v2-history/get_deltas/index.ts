import {FastifyInstance, RouteSchema} from "fastify";
import {getDeltasHandler} from "./get_deltas";
import {addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: RouteSchema = {
        description: 'get state deltas',
        summary: 'get state deltas',
        tags: ['history'],
        querystring: extendQueryStringSchema({
            "code": {
                description: 'contract account',
                type: 'string'
            },
            "scope": {
                description: 'table scope',
                type: 'string'
            },
            "table": {
                description: 'table name',
                type: 'string'
            },
            "payer": {
                description: 'payer account',
                type: 'string'
            }
        }),
        response: extendResponseSchema({
            "deltas": {
                type: "array",
                items: {
                    type: 'object',
                    properties: {
                        "timestamp": {type: 'string'},
                        "code": {type: 'string'},
                        "scope": {type: 'string'},
                        "table": {type: 'string'},
                        "primary_key": {type: 'string'},
                        "payer": {type: 'string'},
                        "present": {type: 'boolean'},
                        "block_num": {type: 'number'},
                        "data": {
                            type: 'object',
                            additionalProperties: true
                        }
                    },
                    additionalProperties: true
                }
            }
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getDeltasHandler,
        schema
    );
    next();
}

