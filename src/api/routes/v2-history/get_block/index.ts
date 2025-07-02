import { FastifyInstance, FastifySchema } from "fastify";
import { addApiRoute, extendResponseSchema, getRouteName } from "../../../helpers/functions.js";
import { getBlockHandler } from "./get_block.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: FastifySchema = {
        description: 'get block by number',
        summary: 'get block by number',
        tags: ['history'],
        querystring: {
            type: 'object',
            properties: {
                "block_num": {
                    description: 'block number',
                    type: 'integer',
                    minimum: 1
                }
            },
            required: ["block_num"]
        },
        response: extendResponseSchema({
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
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        getBlockHandler,
        schema
    );
    next();
}
