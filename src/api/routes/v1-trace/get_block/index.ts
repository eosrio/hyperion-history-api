import {FastifyInstance} from "fastify";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import {getBlockTraceHandler} from "./get_block.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get block traces',
        summary: 'get block traces',
        tags: ['history'],
        body: {
            type: 'object',
            properties: {
                "block_num": {
                    description: 'block number',
                    type: 'integer'
                },
                "block_id": {
                    description: 'block id',
                    type: 'string'
                }
            }
        },
        response: extendResponseSchema({
            "id": {type: "string"},
            "number": {type: "integer"},
            "previous_id": {type: "string"},
            "status": {type: "string"},
            "timestamp": {type: "string"},
            "producer": {type: "string"},
            "transactions": {
                type: "array",
                items: {
                    type: 'object',
                    properties: {
                        "id": {type: "string"},
                        "actions": {
                            type: "array",
                            items: {
                                type: 'object',
                                properties: {
                                    "receiver": {type: "string"},
                                    "account": {type: "string"},
                                    "action": {type: "string"},
                                    "authorization": {
                                        type: "array", items: {
                                            type: 'object',
                                            properties: {
                                                "account": {type: "string"},
                                                "permission": {type: "string"},
                                            }
                                        }
                                    },
                                    "data": {
                                        additionalProperties: true
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })
    };
    addApiRoute(
        fastify,
        'POST',
        getRouteName(import.meta.filename),
        getBlockTraceHandler,
        schema
    );
    next();
}
