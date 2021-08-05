import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeActionMeta, timedQuery} from "../../../helpers/functions";

async function getTransaction(fastify: FastifyInstance, request: FastifyRequest) {

	const query: any = request.query;
	const txId = query.id.toLowerCase();
	const blockHint = parseInt(query.block_hint, 10);
	let indexPartition = '';
	if (blockHint) {
		indexPartition = Math.ceil(blockHint / fastify.manager.config.settings.index_partition_size).toString().padStart(6, '0');
	}
	const _size = fastify.manager.config.api.limits.get_trx_actions || 100;

	let indexPattern = fastify.manager.chain + '-action-*';
	if (indexPartition) {
		indexPattern = fastify.manager.chain + `-action-${fastify.manager.config.settings.index_version}-${indexPartition}`;
	}

	const response = {
		executed: false,
		trx_id: query.id,
		lib: undefined,
		cached_lib: false,
		actions: undefined,
		generated: undefined,
		error: undefined
	};

	let pResults;
	try {
		pResults = await Promise.all([
			new Promise(resolve => {
				const key = `${fastify.manager.chain}_get_info`;
				fastify.redis.get(key).then(value => {
					if (value) {
						response.cached_lib = true;
						resolve(JSON.parse(value));
					} else {
						fastify.eosjs.rpc.get_info().then(value1 => {
							fastify.redis.set(key, JSON.stringify(value1), 'EX', 6);
							response.cached_lib = false;
							resolve(value1);
						}).catch((reason) => {
							console.log(reason);
							response.error = 'failed to get last_irreversible_block_num'
							resolve(null);
						});
					}
				});
			}),
			fastify.elastic.search({
				index: indexPattern,
				size: _size,
				body: {
					query: {bool: {must: [{term: {trx_id: txId}}]}},
					sort: {global_sequence: "asc"}
				}
			})
		]);
	} catch (e) {
		console.log(e.message);
		if (e.meta.statusCode === 404) {
			response.error = 'no data near block_hint'
			return response;
		}
	}
	const results = pResults[1];
	response.lib = pResults[0].last_irreversible_block_num;
	const hits = results['body']['hits']['hits'];
	if (hits.length > 0) {
		let highestBlockNum = 0;
		for (let action of hits) {
			if (action._source.block_num > highestBlockNum) {
				highestBlockNum = action._source.block_num;
			}
		}
		response.actions = [];
		for (let action of hits) {
			if (action._source.block_num === highestBlockNum) {
				mergeActionMeta(action._source);
				response.actions.push(action._source);
			}
		}
		response.executed = true;
	}
	return response;
}

export function getTransactionHandler(fastify: FastifyInstance, route: string) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		reply.send(await timedQuery(getTransaction, fastify, request, route));
	}
}
