import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {connect} from "amqplib";
import {timedQuery} from "../../../helpers/functions";
import {getFirstIndexedBlock, getLastIndexedBlockWithTotalBlocks} from "../../../../helpers/common_functions";



async function checkRabbit(fastify: FastifyInstance): Promise<ServiceResponse<any>> {
    try {
        const connection = await connect(fastify.manager.ampqUrl);
        await connection.close();
        return createHealth('RabbitMq', 'OK');
    } catch (e) {
        console.log(e);
        return createHealth('RabbitMq', 'Error');
    }
}

interface NodeosService {
    head_block_num: number;
    head_block_time: string;
    time_offset: number;
    last_irreversible_block: number;
    chain_id: string;
}

async function checkNodeos(fastify: FastifyInstance): Promise<ServiceResponse<NodeosService>> {
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

interface ESService {
    first_indexed_block: number;
    last_indexed_block: number;
    total_indexed_blocks: number;
    active_shards: string;
    missing_blocks: number;
    missing_pct: string;
    head_offset: number;
}

interface ServiceResponse<T> {
    service: string;
    time: number;
    status: any
    service_data?: T;
}

async function checkElastic(fastify: FastifyInstance): Promise<ServiceResponse<ESService>> {
    try {
        let esStatus = await fastify.elastic.cat.health({format: 'json', v: true});
        let firstIndexedBlock: number;
        const fib = await fastify.redis.get(`${fastify.manager.chain}::fib`);
        if (fib) {
            firstIndexedBlock = parseInt(fib);
        } else {
            firstIndexedBlock = await getFirstIndexedBlock(fastify.elastic, fastify.manager.chain);
            await fastify.redis.set(`${fastify.manager.chain}::fib`, firstIndexedBlock);
        }
        let indexedBlocks = await getLastIndexedBlockWithTotalBlocks(fastify.elastic, fastify.manager.chain);
        const missingCounter = (indexedBlocks[0] - firstIndexedBlock) - indexedBlocks[1];
        const missingPct = (missingCounter * 100 / indexedBlocks[1]).toFixed(2) + "%";
        const data: ESService = {
            first_indexed_block: firstIndexedBlock,
            last_indexed_block: indexedBlocks[0],
            total_indexed_blocks: indexedBlocks[1] + 1,
            active_shards: esStatus.body[0]['active_shards_percent'],
            missing_blocks: (indexedBlocks[0] - firstIndexedBlock) - indexedBlocks[1],
            missing_pct: missingPct,
            head_offset: null
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

function createHealth(name: string, status, data?: any): ServiceResponse<any> {
    let time = Date.now();
    return {
        service: name,
        status: status,
        service_data: data,
        time: time
    }
}

async function getHealthQuery(fastify: FastifyInstance) {
    let response = {
        version: fastify.manager.current_version,
        version_hash: fastify.manager.getServerHash(),
        host: fastify.manager.config.api.server_name,
        health: [],
        features: fastify.manager.config.features
    };
    response.health = await Promise.all([
        checkRabbit(fastify),
        checkNodeos(fastify),
        checkElastic(fastify)
    ]);
    const es = response.health.find(value => value.service === 'Elasticsearch');
    const nodeos = response.health.find(value => value.service === 'NodeosRPC');
    es.service_data.v = nodeos.service_data.head_block_num - es.service_data.last_indexed_block;
    return response;
}

export function healthHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getHealthQuery, fastify, request, route));
    }
}
