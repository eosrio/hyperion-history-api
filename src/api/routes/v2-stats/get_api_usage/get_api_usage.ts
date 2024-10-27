import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {getApiUsageHistory, timedQuery} from "../../../helpers/functions.js";

async function getApiUsage(fastify: FastifyInstance) {
    return await getApiUsageHistory(fastify);
}

export function getApiUsageHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getApiUsage, fastify, request, route));
    }
}
