import { addApiRoute, getRouteName } from "../../../helpers/functions.js";
import { getControlledAccountsHandler } from "./get_controlled_accounts.js";
export default function (fastify, opts, next) {
    addApiRoute(fastify, 'POST', getRouteName(__filename), getControlledAccountsHandler, {
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
