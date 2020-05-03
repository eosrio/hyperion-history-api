import {FastifyInstance} from "fastify";
import {getKeyAccountsHandler} from "./get_key_accounts";
import {addApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {

    // GET
    const getSchema = {
        description: 'get accounts by public key',
        summary: 'get accounts by public key',
        tags: ['accounts'],
        querystring: {
            type: 'object',
            properties: {
                "public_key": {
                    description: 'public key',
                    type: 'string'
                },
                "details": {
                    description: 'include permission details',
                    type: 'boolean'
                },
            },
            required: ["public_key"]
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    "account_names": {
                        type: "array",
                        items: {type: "string"}
                    },
                    "permissions": {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                owner: {type: 'string'},
                                block_num: {type: 'integer'},
                                parent: {type: 'string'},
                                last_updated: {type: 'string'},
                                auth: {},
                                name: {type: 'string'},
                                present: {type: 'boolean'}
                            }
                        }
                    }
                }
            }
        }
    };
    addApiRoute(fastify, 'GET', getRouteName(__filename), getKeyAccountsHandler, getSchema);

    // POST
    const postSchema = {
        description: 'get accounts by public key',
        summary: 'get accounts by public key',
        tags: ['accounts', 'state'],
        body: {
            type: 'object',
            properties: {
                "public_key": {
                    description: 'public key',
                    type: 'string'
                },
            },
            required: ["public_key"]
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    "account_names": {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                }
            }
        }
    };
    addApiRoute(fastify, 'POST', getRouteName(__filename), getKeyAccountsHandler, postSchema);
    next();
}
