import {FastifyInstance} from "fastify";
import {addApiRoute, extendQueryStringSchema, getRouteName} from "../../../helpers/functions.js";
import {getTokensHandler} from "./get_tokens.js";

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
        }, ["account"])
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.url),
        getTokensHandler,
        schema
    );
    next();
}
