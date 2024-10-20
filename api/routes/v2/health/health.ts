import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {connect} from "amqplib";
import {timedQuery} from "../../../helpers/functions";
import {getFirstIndexedBlock, getLastIndexedBlockWithTotalBlocks} from "../../../../helpers/common_functions";
import {ClusterHealthResponse} from "@elastic/elasticsearch/lib/api/types";

interface ESService {
    first_indexed_block: number;
    last_indexed_block: number;
    total_indexed_blocks: number;
    active_shards: string;
    missing_blocks: number;
    missing_pct: string;
    head_offset: number | null;
}

interface ServiceResponse<T> {
    service: string;
    time: number;
    query_time_ms: number;
    status: any
    service_data?: T;
}

interface NodeosService {
    head_block_num: number;
    head_block_time: string;
    time_offset: number;
    last_irreversible_block: number;
    chain_id: string;
}

function createHealth(name: string, status, data?: any, refTime?: bigint): ServiceResponse<any> {
    let time = Date.now();
    return {
        service: name,
        status: status,
        query_time_ms: refTime ? Number(process.hrtime.bigint() - refTime) / 1000000 : 0,
        service_data: data,
        time: time
    }
}


// Test RabbitMQ connection
async function checkRabbit(fastify: FastifyInstance): Promise<ServiceResponse<any>> {
    const tRefRabbit = process.hrtime.bigint();
    try {
        const connection = await connect(fastify.manager.ampqUrl);
        await connection.close();
        return createHealth('RabbitMq', 'OK', null, tRefRabbit);
    } catch (e) {
        console.log(e);
        return createHealth('RabbitMq', 'Error');
    }
}

// Test Nodeos connection and chain info
async function checkNodeos(fastify: FastifyInstance): Promise<ServiceResponse<NodeosService>> {
    const tRefNodeos = process.hrtime.bigint();
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
            }, tRefNodeos);
        } else {
            return createHealth('NodeosRPC', 'Error');
        }
    } catch (e) {
        return createHealth('NodeosRPC', 'Error');
    }
}

// Test Elasticsearch connection and indexed range
async function checkElastic(fastify: FastifyInstance): Promise<ServiceResponse<ESService>> {
    const tRefElastic = process.hrtime.bigint();
    try {
        const esStatusCache = await fastify.redis.get(`${fastify.manager.chain}::es_status`);
        let esStatus: ClusterHealthResponse;
        if (esStatusCache) {
            esStatus = JSON.parse(esStatusCache);
        } else {
            esStatus = await fastify.elastic.cluster.health();
            // cache for 60 seconds
            await fastify.redis.set(`${fastify.manager.chain}::es_status`, JSON.stringify(esStatus), 'EX', 60);
        }

        let firstIndexedBlock: number;

        const fib = await fastify.redis.get(`${fastify.manager.chain}::fib`);
        if (fib) {
            firstIndexedBlock = parseInt(fib);

            console.log(`FIB from cache: ${firstIndexedBlock}`);

        } else {
            firstIndexedBlock = await getFirstIndexedBlock(
                fastify.elastic,
                fastify.manager.chain,
                fastify.manager.config.settings.index_partition_size
            );
            await fastify.redis.set(`${fastify.manager.chain}::fib`, firstIndexedBlock);

            console.log(`FIB from ES: ${firstIndexedBlock}`);
        }

        let indexedBlocks = await getLastIndexedBlockWithTotalBlocks(fastify.elastic, fastify.manager.chain);
        const lastIndexedBlock = indexedBlocks[0];
        const totalIndexed = indexedBlocks[1] - 1;
        const missingCounter = (lastIndexedBlock - firstIndexedBlock) - totalIndexed;
        const missingPct = (missingCounter * 100 / indexedBlocks[1]).toFixed(2) + "%";
        const data: ESService = {
            active_shards: parseFloat(esStatus.active_shards_percent_as_number.toString()).toFixed(1) + "%",
            head_offset: null,
            first_indexed_block: firstIndexedBlock,
            last_indexed_block: lastIndexedBlock,
            total_indexed_blocks: totalIndexed,
            missing_blocks: missingCounter,
            missing_pct: missingPct
        };
        let stat = 'OK';
        switch (esStatus.status) {
            case "yellow":
                stat = 'Warning';
                break;
            case "YELLOW":
                stat = 'Warning';
                break;
            case "red":
                stat = 'Error';
                break;
            case "RED":
                stat = 'Error';
                break;
        }
        return createHealth('Elasticsearch', stat, data, tRefElastic);
    } catch (e) {
        console.log(e, 'Elasticsearch Error');
        return createHealth('Elasticsearch', 'Error');
    }
}

// Main health check query
async function getHealthQuery(fastify: FastifyInstance) {
    let response: {
        version?: string,
        version_hash?: string,
        host: string,
        health: ServiceResponse<any>[],
        limits: any
        features: any
    } = {
        version: fastify.manager.current_version,
        version_hash: fastify.manager.getServerHash(),
        host: fastify.manager.config.api.server_name,
        health: [],
        limits: fastify.manager.config.api.limits,
        features: fastify.manager.config.features
    };
    response.health = await Promise.all([
        checkRabbit(fastify),
        checkNodeos(fastify),
        checkElastic(fastify)
    ]);
    const es = response.health.find(value => value.service === 'Elasticsearch') as ServiceResponse<ESService>;
    const nodeos = response.health.find(value => value.service === 'NodeosRPC') as ServiceResponse<NodeosService>;
    if (nodeos && nodeos.service_data && es && es.service_data) {
        es.service_data.head_offset = nodeos.service_data.head_block_num - es.service_data.last_indexed_block;
    }
    return response;
}

export function healthHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getHealthQuery, fastify, request, route));
    }
}
