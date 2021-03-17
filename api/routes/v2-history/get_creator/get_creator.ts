import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import {timedQuery} from "../../../helpers/functions";

async function getCreator(fastify: FastifyInstance, request: FastifyRequest) {

	const response = {
		account: request.query.account,
		creator: '',
		timestamp: '',
		block_num: 0,
		trx_id: '',
	};

	if (request.query.account === fastify.manager.config.settings.eosio_alias) {
		const genesisBlock = await fastify.eosjs.rpc.get_block(1);
		if (genesisBlock) {
			response.creator = '__self__';
			response.timestamp = genesisBlock.timestamp;
			response.block_num = 1;
			response.trx_id = "";
			return response;
		} else {
			throw new Error("genesis block not found");
		}
	}

	const results = await fastify.elastic.search({
		"index": fastify.manager.chain + '-action-*',
		"body": {
			size: 1,
			query: {
				bool: {
					must: [{term: {"@newaccount.newact": request.query.account}}]
				}
			}
		}
	});

	if (results['body']['hits']['hits'].length === 1) {
		const result = results['body']['hits']['hits'][0]._source;
		response.trx_id = result.trx_id;
		response.block_num = result.block_num;
		response.creator = result.act.data.creator;
		response.timestamp = result['@timestamp'];
		return response;
	} else {
		throw new Error("account creation not found");
	}
}

export function getCreatorHandler(fastify: FastifyInstance, route: string) {
	return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
		reply.send(await timedQuery(getCreator, fastify, request, route));
	}
}
