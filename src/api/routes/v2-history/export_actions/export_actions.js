"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportActionsHandler = void 0;
const functions_1 = require("../../../helpers/functions.js");
async function exportActions(fastify, request) {
}
function exportActionsHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await (0, functions_1.timedQuery)(exportActions, fastify, request, route));
    };
}
exports.exportActionsHandler = exportActionsHandler;
//# sourceMappingURL=export_actions.js.map
