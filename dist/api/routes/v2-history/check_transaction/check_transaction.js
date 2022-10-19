import { timedQuery } from "../../../helpers/functions.js";
async function checkTransaction(fastify, request) {
    const query = request.query;
    const txId = query.id.toLowerCase();
    const data = await fastify.redis.get(txId);
    if (data) {
        const jsonObj = JSON.parse(data);
        const response = {
            id: txId,
            status: jsonObj.status,
            block_num: jsonObj.b,
            root_action: jsonObj.a,
            signatures: [],
        };
        if (jsonObj.s && jsonObj.s.length > 0) {
            response.signatures = jsonObj.s;
        }
        return response;
    }
    else {
        return {
            id: txId,
            status: 'unknown'
        };
    }
}
export function checkTransactionHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(checkTransaction, fastify, request, route));
    };
}
