import {FastifyInstance} from "fastify";
import {getTransactionHandler} from "./get_transaction_legacy";
import {addApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get all actions belonging to the same transaction',
        summary: 'get transaction by id',
        tags: ['history'],
        querystring: {
            type: 'object',
            properties: {
                "id": {
                    description: 'transaction id',
                    type: 'string'
                }
            },
            required: ["id"]
        }
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getTransactionHandler,
        schema
    );
    next();
}
