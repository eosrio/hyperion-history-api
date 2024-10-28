import {FastifyInstance} from "fastify";
import {getTransactionHandler} from "./get_transaction_legacy.js";
import {addApiRoute, getRouteName} from "../../../helpers/functions.js";

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
        getRouteName(import.meta.filename),
        getTransactionHandler,
        schema
    );
    next();
}
