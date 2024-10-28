import {FastifyInstance} from "fastify";
import {addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import {getVoterScopesHandler} from "./get_voter_scopes.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'find voter accounts from a wildcard string',
        summary: 'get filtered voters',
        tags: ['accounts'],
        querystring: extendQueryStringSchema({
            "term": {
                description: 'search string',
                type: 'string',
                minLength: 1,
                maxLength: 12
            }
        }, ["term"]),
        response: extendResponseSchema({
            scopes: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        getVoterScopesHandler,
        schema
    );
    next();
}
