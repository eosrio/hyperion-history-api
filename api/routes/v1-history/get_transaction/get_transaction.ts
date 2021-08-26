import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeActionMeta, timedQuery} from "../../../helpers/functions";
import {createHash} from "crypto";
import flatstr from 'flatstr';
import {GetInfoResult} from "eosjs/dist/eosjs-rpc-interfaces";

async function getTransaction(fastify: FastifyInstance, request: FastifyRequest) {
	if (typeof request.body === 'string') {
		request.body = JSON.parse(request.body)
	}
	const body: any = request.body;
	const redis = fastify.redis;
	const trxId = body.id.toLowerCase();
	const conf = fastify.manager.config;
	const cachedData = await redis.hgetall('trx_' + trxId);

	const response: any = {
		"id": body.id,
		"trx": {
			"receipt": {
				"status": "executed",
				"cpu_usage_us": 0,
				"net_usage_words": 0,
				"trx": [1, {
					"signatures": "",
					"compression": "none",
					"packed_context_free_data": "",
					"packed_trx": ""
				}]
			},
			"trx": {}
		},
		"block_num": 0,
		"block_time": "",
		"last_irreversible_block": undefined,
		"traces": []
	};

	let hits;

	// build get_info request with caching
	const $getInfo = new Promise<GetInfoResult>(resolve => {
		const key = `${fastify.manager.chain}_get_info`;
		fastify.redis.get(key).then(value => {
			if (value) {
				resolve(JSON.parse(value));
			} else {
				fastify.eosjs.rpc.get_info().then(value1 => {
					fastify.redis.set(key, JSON.stringify(value1), 'EX', 6);
					resolve(value1);
				}).catch((reason) => {
					console.log(reason);
					response.error = 'failed to get last_irreversible_block_num'
					resolve(null);
				});
			}
		});
	});

	// reconstruct hits from cached data
	if (cachedData && Object.keys(cachedData).length > 0) {
		const gsArr = [];
		for (let cachedDataKey in cachedData) {
			gsArr.push(cachedData[cachedDataKey]);
		}
		gsArr.sort((a, b) => {
			return a.global_sequence - b.global_sequence;
		});
		hits = gsArr.map(value => {
			return {
				_source: JSON.parse(value)
			};
		});
		const promiseResults = await Promise.all([
			redis.ttl('trx_' + trxId),
			$getInfo
		]);
		response.cache_expires_in = promiseResults[0];
		response.last_irreversible_block = promiseResults[1].last_irreversible_block_num;
	}

	// search on ES if cache is not present
	if (!hits) {
		const _size = conf.api.limits.get_trx_actions || 100;
		const blockHint = parseInt(body.block_num_hint, 10);
		let indexPattern = '';
		if (blockHint) {
			const idxPart = Math.ceil(blockHint / conf.settings.index_partition_size).toString().padStart(6, '0');
			indexPattern = fastify.manager.chain + `-action-${conf.settings.index_version}-${idxPart}`;
		} else {
			indexPattern = fastify.manager.chain + '-action-*';
		}
		let pResults;
		try {

			// build search request
			const $search = fastify.elastic.search({
				index: indexPattern,
				size: _size,
				body: {
					query: {bool: {must: [{term: {trx_id: trxId}}]}},
					sort: {global_sequence: "asc"}
				}
			});

			// execute in parallel
			pResults = await Promise.all([$getInfo, $search]);
		} catch (e) {
			console.log(e.message);
			if (e.meta.statusCode === 404) {
				return response;
			}
		}
		hits = pResults[1]['body']['hits']['hits'];
		response.last_irreversible_block = pResults[0].last_irreversible_block_num;
	}


	if (hits.length > 0) {
		const actions = hits;
		response.trx.trx = {
			"expiration": "",
			"ref_block_num": 0,
			"ref_block_prefix": 0,
			"max_net_usage_words": 0,
			"max_cpu_usage_ms": 0,
			"delay_sec": 0,
			"context_free_actions": [],
			"actions": [],
			"transaction_extensions": [],
			"signatures": [],
			"context_free_data": []
		};
		let traces = {};
		let seqNum = 0;
		for (let action of actions) {
			action = action._source;
			mergeActionMeta(action);
			action.act['hex_data'] = Buffer.from(flatstr(JSON.stringify(action.act.data))).toString('hex');
			if (action.parent === 0) {
				response.trx.trx.actions.push(action.act);
			}
			response.block_num = action.block_num;
			response.block_time = action['@timestamp'];
			seqNum += 1;
			let trace = {
				receipt: {
					receiver: action.act.account,
					global_sequence: String(action.global_sequence),
					auth_sequence: [
						action.act.authorization[0].actor,
						seqNum
					],
					act_digest: '',
					recv_sequence: seqNum,
					code_sequence: 1,
					abi_sequence: 1
				},
				act: action.act,
				account_ram_deltas: action.account_ram_deltas || [],
				context_free: false,
				block_num: action.block_num,
				block_time: action['@timestamp'],
				console: "",
				elapsed: 0,
				except: null,
				inline_traces: [],
				producer_block_id: "",
				trx_id: body.id,
				notified: action.notified
			};
			let hash = createHash('sha256');
			hash.update(JSON.stringify(action.act));
			trace.receipt.act_digest = hash.digest('hex');
			traces[action.global_sequence] = trace;
		}

		actions.forEach(action => {
			action = action._source;
			for (let i = 0; i < traces[action.global_sequence].notified.length; i++) {
				if (traces[action.global_sequence].notified[i] === action.act.account) {
					traces[action.global_sequence].notified.splice(i, 1);
					break;
				}
			}
			if (action.parent !== 0 && action.parent) {
				if (traces[action.parent]) {
					for (let i = 0; i < traces[action.parent].notified.length; i++) {
						if (traces[action.parent].notified[i] === action.act.account) {
							traces[action.parent].notified.splice(i, 1);
							break;
						}
					}
					traces[action.parent].inline_traces.push(traces[action.global_sequence]);
				}
			}
		});

		actions.forEach(action => {
			action = action._source;
			response.traces.push(traces[action.global_sequence]);
			if (traces[action.global_sequence] && traces[action.global_sequence].notified) {
				traces[action.global_sequence].notified.forEach((note, index) => {
					seqNum += 1;
					let trace = {
						receipt: {
							receiver: note,
							global_sequence: String(action.global_sequence + index + 1),
							auth_sequence: [
								action.act.authorization[0].actor,
								seqNum
							],
							act_digest: traces[action.global_sequence].receipt.act_digest,
							recv_sequence: seqNum,
							code_sequence: 1,
							abi_sequence: 1
						},
						account_ram_deltas: action.account_ram_deltas || [],
						act: action.act,
						block_num: action.block_num,
						block_time: action['@timestamp'],
						console: "",
						context_free: false,
						elapsed: 0,
						except: null,
						inline_traces: [],
						producer_block_id: "",
						trx_id: body.id,
					};
					traces[action.global_sequence].inline_traces.unshift(trace);
					response.traces.push(trace);
				});
				delete traces[action.global_sequence].notified;
			}
		});
	} else {
		const errmsg = "Transaction " + body.id.toLowerCase() + " not found in history and no block hint was given";
		return {
			code: 500,
			message: "Internal Service Error",
			error: {
				code: 3040011,
				name: "tx_not_found",
				what: "The transaction can not be found",
				details: [
					{
						message: errmsg,
						file: "",
						line_number: 1,
						method: "get_transaction"
					}
				]
			}
		}
	}
	return response;
}

export function getTransactionHandler(fastify: FastifyInstance, route: string) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		reply.send(await timedQuery(getTransaction, fastify, request, route));
	}
}
