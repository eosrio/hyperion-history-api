import {FastifyInstance} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions.js";
import {getControlledAccountsHandler} from "./get_controlled_accounts.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addApiRoute(fastify, 'POST', getRouteName(import.meta.filename), getControlledAccountsHandler, {
        description: 'get controlled accounts by controlling accounts',
        summary: 'get controlled accounts by controlling accounts',
        tags: ['accounts'],
        body: {
            type: ['object', 'string'],
            properties: {
                "controlling_account": {
                    description: 'controlling account',
                    type: 'string'
                },
            },
            required: ["controlling_account"]
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    "controlled_accounts": {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                }
            }
        }
    });
    next();
}
