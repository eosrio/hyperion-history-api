"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const functions_1 = require("../../../helpers/functions.js");
function default_1(fastify, opts, next) {
    (0, functions_1.addChainApiRoute)(fastify, (0, functions_1.getRouteName)(import.meta.filename), 'Retrieves the scheduled transaction', {
        "lower_bound": {
            "type": "string",
            "description": "Date/time string in the format YYYY-MM-DDTHH:MM:SS.sss",
            "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.[0-9]{3}$",
            "title": "DateTimeSeconds"
        },
        "limit": {
            "description": "The maximum number of transactions to return",
            "type": "integer"
        },
        "json": {
            "description": "true/false whether the packed transaction is converted to json",
            "type": "boolean"
        }
    });
    next();
}
exports.default = default_1;
//# sourceMappingURL=index.js.map
