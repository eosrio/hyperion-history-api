import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {applyTimeFilter} from "../get_actions/functions.js";
import {estypes} from "@elastic/elasticsearch";

async function getBlocks(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    let skip: number = 0;
    let limit: number = 10;
    let sort_direction: estypes.SortOrder = 'desc';
    const mustArray: any[] = [];
    const queryStruct = {
        bool: {
            must: mustArray,
            boost: 1.0
        }
    };

    // Check if this is a single block request
    const singleBlockRequest = query.block_num || query.block_id;

    // Process query parameters
    for (const param in query) {
        if (Object.prototype.hasOwnProperty.call(query, param)) {
            const value = query[param];
            switch (param) {
                case 'limit': {
                    limit = parseInt(value, 10);
                    if (limit < 1) {
                        throw new Error('invalid limit parameter');
                    }
                    break;
                }
                case 'skip': {
                    skip = parseInt(value, 10);
                    if (skip < 0) {
                        throw new Error('invalid skip parameter');
                    }
                    break;
                }
                case 'sort': {
                    if (value === 'asc' || value === '1') {
                        sort_direction = 'asc';
                    } else if (value === 'desc' || value === '-1') {
                        sort_direction = 'desc'
                    } else {
                        throw new Error('invalid sort direction');
                    }
                    break;
                }
                case 'block_num': {
                    const blockNum = parseInt(value, 10);
                    if (blockNum < 1) {
                        throw new Error('Invalid block number');
                    }
                    mustArray.push({term: {"block_num": blockNum}});
                    break;
                }
                case 'block_id': {
                    if (typeof value === 'string' && value.length > 0) {
                        mustArray.push({term: {"block_id": value.toLowerCase()}});
                    }
                    break;
                }
                case 'producer': {
                    if (typeof value === 'string' && value.length > 0) {
                        const values = value.split(",");
                        if (values.length > 1) {
                            mustArray.push({terms: {"producer": values}});
                        } else {
                            mustArray.push({term: {"producer": values[0]}});
                        }
                    }
                    break;
                }
                case 'trx_count': {
                    const trxCount = parseInt(value, 10);
                    if (trxCount >= 0) {
                        mustArray.push({term: {"trx_count": trxCount}});
                    }
                    break;
                }
                case 'min_trx_count': {
                    const minTrxCount = parseInt(value, 10);
                    if (minTrxCount >= 0) {
                        mustArray.push({range: {"trx_count": {gte: minTrxCount}}});
                    }
                    break;
                }
                case 'max_trx_count': {
                    const maxTrxCount = parseInt(value, 10);
                    if (maxTrxCount >= 0) {
                        mustArray.push({range: {"trx_count": {lte: maxTrxCount}}});
                    }
                    break;
                }
                case 'before':
                case 'after': {
                    // These are handled by applyTimeFilter
                    break;
                }
                default: {
                    // Skip unknown parameters
                    break;
                }
            }
        }
    }

    // Apply time filter
    applyTimeFilter(query, queryStruct);

    // Set limits
    const maxBlocks = fastify.manager.config.api.limits.get_blocks ?? 1000;
    const finalLimit = singleBlockRequest ? 1 : (limit > maxBlocks ? maxBlocks : limit);

    // Perform search
    const results = await fastify.elastic.search<any>({
        index: fastify.manager.chain + '-block-' + fastify.manager.config.settings.index_version + '-*',
        from: skip,
        size: finalLimit,
        query: queryStruct,
        sort: [{block_num: {order: sort_direction}}]
    });

    if (singleBlockRequest && results.hits.hits.length === 0) {
        throw new Error(`Block not found`);
    }

    // Format response
    const blocks = results.hits.hits.map((hit: any) => {
        const block = hit._source;
        const blockData: any = {
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
            blockData.new_producers = block.new_producers;
        }

        return blockData;
    });

    const response: any = {
        cached: false,
        lib: 0,
        total: results.hits.total,
        blocks: blocks
    };

    return response;
}

export function getBlocksHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getBlocks, fastify, request, route));
    }
}
