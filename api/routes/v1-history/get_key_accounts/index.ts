import {FastifyInstance} from "fastify";
import {getKeyAccountsHandler} from "../../v2-state/get_key_accounts/get_key_accounts";
import {addApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {

    // POST
    addApiRoute(fastify, 'POST', getRouteName(__filename), getKeyAccountsHandler, {
        description: 'get accounts by public key',
        summary: 'get accounts by public key',
        tags: ['accounts'],
        body: {
            type: ['object', 'string'],
            properties: {"public_key": {description: 'public key', type: 'string'}},
            required: ["public_key"]
        },
        response: {
            200: {
                type: 'object',
                properties: {"account_names": {type: "array", items: {type: "string"}}}
            }
        }
    });
    next();
}
