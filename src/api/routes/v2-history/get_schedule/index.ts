import {FastifyInstance} from "fastify";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import {getScheduleHandler} from "./get_schedule.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get producer schedule by version',
        summary: 'get producer schedule by version',
        tags: ['history'],
        querystring: {
            type: 'object',
            properties: {
                "producer": {
                    description: 'search by producer',
                    type: 'string'
                },
                "key": {
                    description: 'search by signing key',
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
                "mode": {
                    description: 'search mode (activated or proposed)',
                    type: 'string',
                },
                "version": {
                    description: 'schedule version',
                    type: 'integer',
                    minimum: 1
                }
            }
        },
        response: extendResponseSchema({
            "timestamp": {type: "string"},
            "block_num": {type: "number"},
            "proposed_block_num": {type: "number"},
            "version": {type: "number"},
            "producers": {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        "producer_name": {type: "string"},
                        "name": {type: "string"},
                        "block_signing_key": {type: "string"},
                        "legacy_key": {type: "string"},
                        "keys": {type: "array", items: {type: "string"}}
                    }
                }
            },
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        getScheduleHandler,
        schema
    );
    next();
}
