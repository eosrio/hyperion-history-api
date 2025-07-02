import { FastifyInstance } from "fastify";
import { addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName } from "../../../helpers/functions.js";
import { getTokensHandler } from "./get_tokens.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get tokens from an account',
        summary: 'get all tokens',
        tags: ['accounts'],
        querystring: extendQueryStringSchema({
            "account": {
                description: 'account name',
                type: 'string',
                minLength: 1,
                maxLength: 12
            }
        },
            ["account"]),
        response: extendResponseSchema({
            account: {type: "string"},
            tokens: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        symbol: { type: "string" },
                        precision: { type: "number" },
                        amount: { type: "number" },
                        contract: { type: "string" },
                    }
                }
            }
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        getTokensHandler,
        schema
    );
    next();
}
