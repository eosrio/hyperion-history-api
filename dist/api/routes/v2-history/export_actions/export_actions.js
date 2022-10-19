import { timedQuery } from "../../../helpers/functions.js";
async function exportActions(fastify, request) {
}
export function exportActionsHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(exportActions, fastify, request, route));
    };
}
