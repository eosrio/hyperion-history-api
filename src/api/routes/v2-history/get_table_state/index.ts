import {FastifyInstance} from "fastify";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import {getTableStateHandler} from "./get_table_state.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get table state at a specific block height',
        summary: 'get table state at a specific block height',
        tags: ['history'],
        querystring: {
            type: 'object',
            required: ["code","table"],
            properties: {
                "code": {
                    description: 'search by contract',
                    type: 'string'
                },
                "table": {
                    description: 'search by key',
                    type: 'string'
                },
                "block_num": {
                    description: 'target block',
                    type: 'integer',
                    minimum: 1
                },
                "after_key": {
                    description: 'last key for pagination',
                    type: 'string'
                }
            }
        },
        response: extendResponseSchema({
            "code": {type: 'string'},
            "table": {type: 'string'},
            "block_num": {type: 'number'},
            "after_key": {type: 'string'},
            "next_key": {type: 'string'},
            "results": {
                type: "array",
                items: {
                    type: 'object',
                    properties: {
                        "scope": {type: 'string'},
                        "primary_key": {type: 'string'},
                        "payer": {type: 'string'},
                        "timestamp": {type: 'string'},
                        "block_num": {type: 'number'},
                        "block_id": {type: 'string'},
                        "present": {type: 'number'},
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
        getTableStateHandler,
        schema
    );
    next();
}
