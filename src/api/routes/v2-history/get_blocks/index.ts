import { FastifyInstance, FastifySchema } from "fastify";
import { addApiRoute, extendResponseSchema, getRouteName } from "../../../helpers/functions.js";
import { getBlocksHandler } from "./get_blocks.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: FastifySchema = {
        description: 'get blocks with various filters',
        summary: 'get blocks with various filters',
        tags: ['history'],
        querystring: {
            type: 'object',
            properties: {
                "block_num": {
                    description: 'specific block number (returns single block)',
                    type: 'integer',
                    minimum: 1
                },
                "block_id": {
                    description: 'specific block id (returns single block)',
                    type: 'string'
                },
                "producer": {
                    description: 'filter by block producer',
                    type: 'string'
                },
                "trx_count": {
                    description: 'filter by transaction count',
                    type: 'integer',
                    minimum: 0
                },
                "min_trx_count": {
                    description: 'minimum transaction count',
                    type: 'integer',
                    minimum: 0
                },
                "max_trx_count": {
                    description: 'maximum transaction count',
                    type: 'integer',
                    minimum: 0
                },
                "after": {
                    description: 'filter after specified date as ISO string',
                    type: 'string'
                },
                "before": {
                    description: 'filter before specified date as ISO string',
                    type: 'string'
                },
                "limit": {
                    description: 'number of blocks to return (default: 10)',
                    type: 'integer',
                    minimum: 1
                },
                "skip": {
                    description: 'number of blocks to skip (default: 0)',
                    type: 'integer',
                    minimum: 0
                },
                "sort": {
                    description: 'sort direction (asc, desc, 1, -1)',
                    type: 'string'
                }
            }
        },
        response: extendResponseSchema({
            "blocks": {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        "@timestamp": {
                            type: "string"
                        },
                        "block_num": {
                            type: "integer"
                        },
                        "block_id": {
                            type: "string"
                        },
                        "prev_id": {
                            type: "string"
                        },
                        "producer": {
                            type: "string"
                        },
                        "new_producers": {
                            type: "object",
                            additionalProperties: true
                        },
                        "schedule_version": {
                            type: "integer"
                        },
                        "cpu_usage": {
                            type: "integer"
                        },
                        "net_usage": {
                            type: "integer"
                        },
                        "trx_count": {
                            type: "integer"
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
        getBlocksHandler,
        schema
    );
    next();
}
