import {FastifyInstance} from "fastify";
import {getAccountHandler} from "./get_account.js";
import {addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import {getActionResponseSchema} from "../../v2-history/get_actions/index.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get account data',
        summary: 'get account summary',
        tags: ['accounts'],
        querystring: extendQueryStringSchema({
            "account": {
                description: 'account name',
                type: 'string',
                minLength: 1,
                maxLength: 12
            }
        }, ["account"]),
        response: extendResponseSchema({
            "account": {
                additionalProperties: true
            },
            "links": {
                type: "array",
                items: {
                    type: 'object',
                    properties: {
                        "timestamp": {type: "string"},
                        "permission": {type: "string"},
                        "code": {type: "string"},
                        "action": {type: "string"},
                    }
                }
            },
            "tokens": {
                type: "array",
                items: {
                    type: 'object',
                    properties: {
                        "symbol": {type: "string"},
                        "precision": {type: "integer"},
                        "amount": {type: "number"},
                        "contract": {type: "string"},
                    }
                }
            },
            "total_actions": {type: "number"},
            "actions": {
                type: "array",
                items: {
                    type: 'object',
                    properties: getActionResponseSchema
                }
            },
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getAccountHandler,
        schema
    );
    next();
}
