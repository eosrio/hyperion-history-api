import {FastifyInstance} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions.js";
import {getTransactionHandler} from "./get_transaction.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addApiRoute(fastify, 'POST', getRouteName(import.meta.url), getTransactionHandler, {
        description: 'get all actions belonging to the same transaction',
        summary: 'get transaction by id',
        tags: ['history'],
        body: {
            anyOf: [
                {
                    type: 'string'
                },
                {
                    type: 'object',
                    properties: {
                        id: {description: 'transaction id', type: 'string'},
                        block_num_hint: {description: 'block number hint', type: 'integer'},
                    },
                    required: ["id"]
                }
            ]
        }
    });
    next();
}
