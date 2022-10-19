import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";

async function exportActions(fastify: FastifyInstance, request: FastifyRequest) {

}

export function exportActionsHandler(fastify: FastifyInstance, route: string) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		reply.send(await timedQuery(exportActions, fastify, request, route));
	}
}
