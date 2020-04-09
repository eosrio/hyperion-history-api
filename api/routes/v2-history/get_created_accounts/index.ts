import {FastifyInstance, RouteSchema} from "fastify";
import {getCreatedAccountsHandler} from "./get_created_accounts";
import {addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: RouteSchema = {
        description: 'get all accounts created by one creator',
        summary: 'get created accounts',
        tags: ['accounts', 'history'],
        querystring: extendQueryStringSchema({
            "account": {
                description: 'creator account',
                type: 'string',
                minLength: 1,
                maxLength: 12
            }
        }, ["account"]),
        response: extendResponseSchema({
            "query_time": {
                type: "number"
            },
            "total": {
                type: "object",
                properties: {
                    "value": {type: "number"},
                    "relation": {type: "string"}
                }
            },
            "accounts": {
                type: "array",
                items: {
                    type: 'object',
                    properties: {
                        'name': {type: 'string'},
                        'timestamp': {type: 'string'},
                        'trx_id': {type: 'string'}
                    }
                }
            }
        })
    };
    addApiRoute(fastify, 'GET', getRouteName(__filename), getCreatedAccountsHandler, schema);
    next();
}
