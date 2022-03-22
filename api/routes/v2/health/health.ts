import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {connect} from "amqplib";
import {timedQuery} from "../../../helpers/functions";
import {getLastIndexedBlockWithTotalBlocks} from "../../../../helpers/common_functions";

async function checkRabbit(fastify: FastifyInstance) {
	try {
		const connection = await connect(fastify.manager.ampqUrl);
		await connection.close();
		return createHealth('RabbitMq', 'OK');
	} catch (e:any) {
		console.log(e);
		return createHealth('RabbitMq', 'Error');
	}
}

async function checkNodeos(fastify: FastifyInstance) {
	const rpc = fastify.manager.nodeosJsonRPC;
	try {
		const results = await rpc.get_info();
		if (results) {
			const diff = (new Date().getTime()) - (new Date(results.head_block_time + '+00:00').getTime());
			return createHealth('NodeosRPC', 'OK', {
				head_block_num: results.head_block_num,
				head_block_time: results.head_block_time,
				time_offset: diff,
				last_irreversible_block: results.last_irreversible_block_num,
				chain_id: results.chain_id
			});
		} else {
			return createHealth('NodeosRPC', 'Error');
		}
	} catch (e:any) {
		return createHealth('NodeosRPC', 'Error');
	}
}

async function checkElastic(fastify: FastifyInstance) {
	try {
		let esStatus = await fastify.elastic.cat.health({format: 'json', v: true});
		let indexedBlocks = await getLastIndexedBlockWithTotalBlocks(fastify.elastic, fastify.manager.chain);
		const data = {
			last_indexed_block: indexedBlocks[0],
			total_indexed_blocks: indexedBlocks[1] + 1,
			active_shards: esStatus[0]['active_shards_percent']
		};
		let stat = 'OK';
		esStatus.forEach(status => {
			if (status.status === 'yellow' && stat !== 'Error') {
				stat = 'Warning'
			} else if (status.status === 'red') {
				stat = 'Error'
			}
		});
		return createHealth('Elasticsearch', stat, data);
	} catch (e:any) {
		console.log(e, 'Elasticsearch Error');
		return createHealth('Elasticsearch', 'Error');
	}
}

function createHealth(name: string, status, data?: any) {
	let time = Date.now();
	return {
		service: name,
		status: status,
		service_data: data,
		time: time
	}
}

async function getHealthQuery(fastify: FastifyInstance, request: FastifyRequest) {
	let response = {
		version: fastify.manager.current_version,
		version_hash: fastify.manager.getServerHash(),
		host: fastify.manager.config.api.server_name,
		health: [],
		features: fastify.manager.config.features
	};
	response.health.push(await checkRabbit(fastify));
	response.health.push(await checkNodeos(fastify));
	response.health.push(await checkElastic(fastify));
	return response;
}

export function healthHandler(fastify: FastifyInstance, route: string) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		reply.send(await timedQuery(getHealthQuery, fastify, request, route));
	}
}
