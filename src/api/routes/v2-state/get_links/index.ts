import {FastifyInstance} from "fastify";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import {getLinksHandler} from "./get_links.js";

export default function (fastify: FastifyInstance, opts: any, next: (err?: Error) => void) {
    const schema = {
        description: 'get permission links',
        summary: 'get permission links',
        tags: ['accounts'],
        querystring: {
            type: 'object',
            properties: {
                "account": {
                    description: 'account name',
                    type: 'string'
                },
                "code": {
                    description: 'contract name',
                    type: 'string'
                },
                "action": {
                    description: 'method name',
                    type: 'string'
                },
                "permission": {
                    description: 'permission name',
                    type: 'string'
                }
            }
        },
        response: extendResponseSchema({
            "links": {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        "block_num": {type: "number"},
                        "timestamp": {type: "string"},
                        "account": {type: "string"},
                        "permission": {type: "string"},
                        "code": {type: "string"},
                        "action": {type: "string"},
                        "irreversible": {type: "boolean"}
                    }
                }
            },
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.url),
        getLinksHandler,
        schema
    );
    next();
}
