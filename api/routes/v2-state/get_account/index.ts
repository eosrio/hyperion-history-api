import {FastifyInstance} from "fastify";
import {getAccountHandler} from "./get_account";
import {addApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get account data',
        summary: 'get account summary',
        tags: ['accounts', 'state'],
        querystring: {
            type: 'object',
            properties: {
                "account": {
                    description: 'account name',
                    type: 'string'
                }
            }
        }
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
