import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";

async function getBlock(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const block_num = parseInt(query.block_num);

    if (!block_num || block_num < 1) {
        throw new Error('Invalid block number');
    }

    const results = await fastify.elastic.search<any>({
        index: fastify.manager.chain + '-block-*',
        size: 1,
        query: {
            bool: {
                must: [
                    { term: { "block_num": block_num } }
                ]
            }
        }
    });

    if (results.hits.hits.length === 0) {
        throw new Error(`Block ${block_num} not found`);
    }

    const block = results.hits.hits[0]._source;
    
    const response: any = {
        cached: false,
        lib: 0,
        total: {
            value: 1,
            relation: "eq"
        },
        '@timestamp': block['@timestamp'],
        block_num: block.block_num,
        block_id: block.block_id,
        prev_id: block.prev_id,
        producer: block.producer,
        schedule_version: block.schedule_version,
        cpu_usage: block.cpu_usage,
        net_usage: block.net_usage,
        trx_count: block.trx_count
    };

    // Include new_producers only if it exists
    if (block.new_producers) {
        response.new_producers = block.new_producers;
    }

    return response;
}

export function getBlockHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getBlock, fastify, request, route));
    }
}
