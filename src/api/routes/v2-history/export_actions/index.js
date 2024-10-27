"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const functions_1 = require("../../../helpers/functions.js");
const get_creator_1 = require("../get_creator/get_creator.js");
function default_1(fastify, opts, next) {
    const schema = {
        description: 'request large action data export',
        summary: 'request large action data export',
        tags: ['history']
    };
    (0, functions_1.addApiRoute)(fastify, 'GET', (0, functions_1.getRouteName)(__filename), get_creator_1.getCreatorHandler, schema);
    next();
}
exports.default = default_1;
//# sourceMappingURL=index.js.map
