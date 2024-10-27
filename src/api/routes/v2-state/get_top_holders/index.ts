import {FastifyInstance} from "fastify";
import {addApiRoute, extendQueryStringSchema, getRouteName} from "../../../helpers/functions.js";
import { getTopHoldersHandler } from "./get_top_holders.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get the list of top holders for a given token',
        summary: 'get top token holders',
        tags: ['accounts'],
        querystring: extendQueryStringSchema({
            "contract": {
                description: 'token contract account name',
                type: 'string',
                minLength: 1,
                maxLength: 12
            },
            "symbol": {
                    description: 'filter by token symbol',
                    type: 'string'
                },
        }, ["contract"])
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getTopHoldersHandler,
        schema
    );
    next();
}
