import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {connect} from "amqplib";
import {timedQuery} from "../../../helpers/functions";
import {getFirstIndexedBlock, getLastIndexedBlockWithTotalBlocks} from "../../../../helpers/common_functions";

async function checkRabbit(fastify: FastifyInstance) {
    try {
        const connection = await connect(fastify.manager.ampqUrl);
        await connection.close();
        return createHealth('RabbitMq', 'OK');
    } catch (e) {
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
    } catch (e) {
        return createHealth('NodeosRPC', 'Error');
    }
}

async function checkElastic(fastify: FastifyInstance) {
    try {
        let esStatus = await fastify.elastic.cat.health({format: 'json', v: true});
        let firstIndexedBlock: number = -1;
        const fib = await fastify.redis.get(`${fastify.manager.chain}::fib`);
        if (fib) {
            firstIndexedBlock = parseInt(fib);
        } else {
            firstIndexedBlock = await getFirstIndexedBlock(fastify.elastic, fastify.manager.chain);
            await fastify.redis.set(`${fastify.manager.chain}::fib`,firstIndexedBlock);
        }
        let indexedBlocks = await getLastIndexedBlockWithTotalBlocks(fastify.elastic, fastify.manager.chain);
        const data = {
            first_indexed_block: firstIndexedBlock,
            last_indexed_block: indexedBlocks[0],
            total_indexed_blocks: indexedBlocks[1] + 1,
            active_shards: esStatus.body[0]['active_shards_percent'],
            missing_blocks: (indexedBlocks[0] - firstIndexedBlock) - indexedBlocks[1]
        };
        let stat = 'OK';
        esStatus.body.forEach(status => {
            if (status.status === 'yellow' && stat !== 'Error') {
                stat = 'Warning'
            } else if (status.status === 'red') {
                stat = 'Error'
            }
        });
        return createHealth('Elasticsearch', stat, data);
    } catch (e) {
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
