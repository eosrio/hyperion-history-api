import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions";

async function checkTransaction(fastify: FastifyInstance, request: FastifyRequest) {
	const query: any = request.query;
	const data = await fastify.redis.get(query.id.toLowerCase())
	if (data) {
		return JSON.parse(data);
	} else {
		return {};
	}
}

export function checkTransactionHandler(fastify: FastifyInstance, route: string) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		reply.send(await timedQuery(checkTransaction, fastify, request, route));
	}
}
