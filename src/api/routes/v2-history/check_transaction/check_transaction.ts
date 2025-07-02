import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";

async function checkTransaction(fastify: FastifyInstance, request: FastifyRequest) {
	const query: any = request.query;
	const txId = query.id.toLowerCase();
	const data = await fastify.redis.get(txId) as any;
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
	} else {
		return {
			id: txId,
			status: 'unknown'
		};
	}
}

export function checkTransactionHandler(fastify: FastifyInstance, route: string) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		reply.send(await timedQuery(checkTransaction, fastify, request, route));
	}
}
