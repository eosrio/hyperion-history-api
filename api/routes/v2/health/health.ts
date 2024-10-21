import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {connect} from "amqplib";
import {timedQuery} from "../../../helpers/functions";
import {getFirstIndexedBlock, getLastIndexedBlockWithTotalBlocks, hLog} from "../../../../helpers/common_functions";

interface ESService {
    first_indexed_block: number;
    last_indexed_block: number;
    total_indexed_blocks: number;
    active_shards: string;
    shards_availability_symptom?: string;
    disk_status?: string;
    missing_blocks: number;
    missing_pct: string;
    head_offset: number | null;
    times: {
        phase: string;
        phase_time_ms: number;
        cache: boolean;
    }[];
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
    try {

        const times: any[] = [];
        const esHealthCache = await fastify.redis.get(`${fastify.manager.chain}::es_status`);

        // Cluster health
        let esHealth: any | undefined;
        const tRefElastic1 = process.hrtime.bigint();
        if (esHealthCache) {
            esHealth = JSON.parse(esHealthCache);
            times.push({
                phase: 'cluster_health',
                phase_time_ms: Number(process.hrtime.bigint() - tRefElastic1) / 1000000,
                cache: true
            });
        } else {

            const esVersion = fastify.elastic_version;
            const [major, minor, rev] = esVersion.split('.').map(Number);
            // check if version is higher than 8.7
            if (major > 8 || (major === 8 && minor >= 7)) {

                // console.log('Using new health report');

                try {
                    const healthReport = await fastify.elastic.healthReport({verbose: false});
                    esHealth = {
                        status: healthReport.status
                    }
                    if (healthReport.indicators.shards_availability) {
                        let status = healthReport.indicators.shards_availability.status;
                        if (status === 'green') {
                            esHealth.shards_availability = '100.0%';
                        } else {
                            esHealth.shards_availability = status;
                            esHealth.shards_availability_symptom = healthReport.indicators.shards_availability.symptom;
                        }
                    }
                    if (healthReport.indicators.disk) {
                        esHealth.disk = healthReport.indicators.disk.status;
                    }
                } catch (e: any) {
                    hLog(`Failed to get health report: ${e.message}`);
                }
            }

            if (!esHealth) {

                // console.log('Using /_cluster/health');

                const esStatus = await fastify.elastic.cluster.health({index: `${fastify.manager.chain}-*`});
                const activeShards = parseFloat(esStatus.active_shards_percent_as_number.toString()).toFixed(1) + "%";
                esHealth = {
                    status: esStatus.status,
                    shards_availability: activeShards
                };
            }

            times.push({
                phase: 'cluster_health',
                phase_time_ms: Number(process.hrtime.bigint() - tRefElastic1) / 1000000,
                cache: false
            });

            // cache for 30 minutes
            await fastify.redis.set(`${fastify.manager.chain}::es_status`, JSON.stringify(esHealth), 'EX', 60 * 30);
        }

        // First indexed block
        let firstIndexedBlock: number;
        const tRefElastic2 = process.hrtime.bigint();
        const fib = await fastify.redis.get(`${fastify.manager.chain}::fib`);
        if (fib) {
            firstIndexedBlock = parseInt(fib);
            times.push({
                phase: 'first_indexed_block',
                phase_time_ms: Number(process.hrtime.bigint() - tRefElastic2) / 1000000,
                cache: true
            });
        } else {
            firstIndexedBlock = await getFirstIndexedBlock(
                fastify.elastic,
                fastify.manager.chain,
                fastify.manager.config.settings.index_partition_size
            );
            await fastify.redis.set(`${fastify.manager.chain}::fib`, firstIndexedBlock);
            times.push({
                phase: 'first_indexed_block',
                phase_time_ms: Number(process.hrtime.bigint() - tRefElastic2) / 1000000,
                cache: false
            });
        }


        // Last indexed block
        const tRefElastic3 = process.hrtime.bigint();
        let indexedBlocks = await getLastIndexedBlockWithTotalBlocks(fastify.elastic, fastify.manager.chain);
        times.push({
            phase: 'last_indexed_block',
            phase_time_ms: Number(process.hrtime.bigint() - tRefElastic3) / 1000000,
            cache: false
        });

        // Calculate missing blocks
        const lastIndexedBlock = indexedBlocks[0];
        const totalIndexed = indexedBlocks[1] - 1;
        const missingCounter = (lastIndexedBlock - firstIndexedBlock) - totalIndexed;
        const missingPct = (missingCounter * 100 / indexedBlocks[1]).toFixed(2) + "%";

        // Data Response
        const data: ESService = {
            active_shards: esHealth.shards_availability,
            disk_status: esHealth.disk,
            head_offset: null,
            first_indexed_block: firstIndexedBlock,
            last_indexed_block: lastIndexedBlock,
            total_indexed_blocks: totalIndexed,
            missing_blocks: missingCounter,
            missing_pct: missingPct,
            times: times
        };

        if (esHealth.shards_availability_symptom) {
            data.shards_availability_symptom = esHealth.shards_availability_symptom;
        }

        let stat = 'OK';
        switch (esHealth.status) {
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
        return createHealth('Elasticsearch', stat, data, tRefElastic1);
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
