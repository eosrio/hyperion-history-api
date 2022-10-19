import { getCreatorHandler } from "./get_creator.js";
import { addApiRoute, extendResponseSchema, getRouteName } from "../../../helpers/functions.js";
export default function (fastify, opts, next) {
    const schema = {
        description: 'get account creator',
        summary: 'get account creator',
        tags: ['accounts'],
        querystring: {
            type: 'object',
            properties: {
                "account": {
                    description: 'created account',
                    type: 'string',
                    minLength: 1,
                    maxLength: 12
                }
            },
            required: ["account"]
        },
        response: extendResponseSchema({
            "account": {
                type: "string"
            },
            "creator": {
                type: "string"
            },
            "timestamp": {
                type: "string"
            },
            "block_num": {
                type: "integer"
            },
            "trx_id": {
                type: "string"
            },
            "indirect_creator": {
                type: "string"
            }
        })
    };
    addApiRoute(fastify, 'GET', getRouteName(__filename), getCreatorHandler, schema);
    next();
}
