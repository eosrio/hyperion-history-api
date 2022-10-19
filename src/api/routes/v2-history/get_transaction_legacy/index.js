"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const get_transaction_legacy_1 = require("./get_transaction_legacy.js");
const functions_1 = require("../../../helpers/functions.js");
function default_1(fastify, opts, next) {
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
    (0, functions_1.addApiRoute)(fastify, 'GET', (0, functions_1.getRouteName)(__filename), get_transaction_legacy_1.getTransactionHandler, schema);
    next();
}
exports.default = default_1;
//# sourceMappingURL=index.js.map
