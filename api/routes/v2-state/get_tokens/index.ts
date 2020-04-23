import {FastifyInstance} from "fastify";
import {addApiRoute, extendQueryStringSchema, getRouteName} from "../../../helpers/functions";
import {getTokensHandler} from "./get_tokens";

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
        }, ["account"])
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getTokensHandler,
        schema
    );
    next();
}
