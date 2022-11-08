import {FastifyInstance} from "fastify";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import {getMissedBlocksHandler} from "./get_missed_blocks.js";

export default function (fastify: FastifyInstance, opts: any, next: (err?: Error) => void) {
    const schema = {
        description: 'get missed blocks',
        summary: 'get missed blocks',
        tags: ['stats'],
        querystring: {
            type: 'object',
            properties: {
                "producer": {
                    description: 'filter by producer',
                    type: 'string'
                },
                "after": {
                    description: 'filter after specified date (ISO8601)',
                    type: 'string'
                },
                "before": {
                    description: 'filter before specified date (ISO8601)',
                    type: 'string'
                },
                "min_blocks": {
                    description: 'min. blocks threshold',
                    type: 'integer',
                    minimum: 1
                }
            }
        },
        response: extendResponseSchema({
            "stats": {
                type: "object",
                properties: {
                    "by_producer": {}
                }
            },
            "events": {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        "@timestamp": {type: "string"},
                        "last_block": {type: "number"},
                        "schedule_version": {type: "number"},
                        "size": {type: "number"},
                        "producer": {type: "string"},
                    }
                }
            },
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.url),
        getMissedBlocksHandler,
        schema
    );
    next();
}
