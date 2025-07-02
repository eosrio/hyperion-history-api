import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timedQuery } from "../../../helpers/functions.js";
import { applyTimeFilter } from "../../v2-history/get_actions/functions.js";

async function getTrxCount(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const mustArray: any[] = [];

    // Build the query structure
    const queryStruct = {
        bool: {
            must: mustArray,
            boost: 1.0
        }
    };

    // Handle block range filters
    if (query.start_block || query.end_block) {
        const rangeQuery: any = {};
        if (query.start_block) {
            const startBlock = parseInt(query.start_block, 10);
            if (startBlock < 1) {
                throw new Error('Invalid start_block parameter');
            }
            rangeQuery.gte = startBlock;
        }
        if (query.end_block) {
            const endBlock = parseInt(query.end_block, 10);
            if (endBlock < 1) {
                throw new Error('Invalid end_block parameter');
            }
            rangeQuery.lte = endBlock;
        }
        if (Object.keys(rangeQuery).length > 0) {
            mustArray.push({ range: { "block_num": rangeQuery } });
        }
    }

    // Handle producer filter
    if (query.producer) {
        if (typeof query.producer === 'string' && query.producer.length > 0) {
            const values = query.producer.split(",");
            if (values.length > 1) {
                mustArray.push({ terms: { "producer": values } });
            } else {
                mustArray.push({ term: { "producer": values[0] } });
            }
        }
    }

    // Apply time filter
    applyTimeFilter(query, queryStruct);

    // Build aggregations
    const aggregations: any = {
        total_trx_count: {
            sum: {
                field: "trx_count"
            }
        },
        block_count: {
            value_count: {
                field: "block_num"
            }
        },
        min_block: {
            min: {
                field: "block_num"
            }
        },
        max_block: {
            max: {
                field: "block_num"
            }
        }
    };

    // Add grouping aggregations based on group_by parameter
    if (query.group_by) {
        switch (query.group_by) {
            case 'producer':
                aggregations.grouped_stats = {
                    terms: {
                        field: "producer",
                        size: 1000
                    },
                    aggs: {
                        trx_count_sum: {
                            sum: {
                                field: "trx_count"
                            }
                        },
                        block_count: {
                            value_count: {
                                field: "block_num"
                            }
                        }
                    }
                };
                break;
            case 'hour':
                aggregations.grouped_stats = {
                    date_histogram: {
                        field: "@timestamp",
                        calendar_interval: "hour"
                    },
                    aggs: {
                        trx_count_sum: {
                            sum: {
                                field: "trx_count"
                            }
                        },
                        block_count: {
                            value_count: {
                                field: "block_num"
                            }
                        }
                    }
                };
                break;
            case 'day':
                aggregations.grouped_stats = {
                    date_histogram: {
                        field: "@timestamp",
                        calendar_interval: "day"
                    },
                    aggs: {
                        trx_count_sum: {
                            sum: {
                                field: "trx_count"
                            }
                        },
                        block_count: {
                            value_count: {
                                field: "block_num"
                            }
                        }
                    }
                };
                break;
            default:
                throw new Error('Invalid group_by parameter. Must be one of: producer, hour, day');
        }
    }

    // Perform the aggregation query
    const searchParams = {
        index: fastify.manager.chain + '-block-' + fastify.manager.config.settings.index_version,
        size: 0, // We only want aggregations, not documents
        query: queryStruct,
        aggs: aggregations
    };

    const esResponse = await fastify.elastic.search<any>(searchParams);
    const aggs = esResponse.aggregations as any;

    if (!aggs) {
        throw new Error('Aggregation response is empty');
    }

    // Build response
    const response: any = {
        total_trx_count: aggs.total_trx_count?.value || 0,
        block_count: aggs.block_count?.value || 0,
        avg_trx_per_block: 0,
        start_block: aggs.min_block?.value || null,
        end_block: aggs.max_block?.value || null
    };

    // Calculate average transactions per block
    if (response.block_count > 0) {
        response.avg_trx_per_block = Math.round((response.total_trx_count / response.block_count) * 100) / 100;
    }

    // Validate actions if requested
    if (query.validate_actions === true || query.validate_actions === 'true') {
        // Build query for action index with same filters
        const actionQueryStruct = {
            bool: {
                must: [
                    ...mustArray,
                    { term: { "creator_action_ordinal": 0 }},
                    { term: { "action_ordinal": 1 }}
                ],
                must_not: [
                    // Filter out onblock actions from eosio contract (system-generated, not user transactions)
                    {
                        bool: {
                            must: [
                                { term: { "act.account": "eosio" } },
                                { term: { "act.name": "onblock" } }
                            ]
                        }
                    }
                ],
                boost: 1.0
            }
        };

        // Apply time filter to action query as well
        applyTimeFilter(query, actionQueryStruct);

        const actionSearchParams = {
            index: fastify.manager.chain + '-action-' + fastify.manager.config.settings.index_version + '-*',
            size: 0,
            query: actionQueryStruct,
            aggs: {
                total_action_count: { value_count: { field: "cpu_usage_us" } }
            }
        };

        const actionResponse = await fastify.elastic.search<any>(actionSearchParams);
        const actionAggs = actionResponse.aggregations as any;

        const totalActionCount = actionAggs?.total_action_count?.value || 0;
        const transactionCountFromBlocks = response.total_trx_count;
        const missingActions = transactionCountFromBlocks - totalActionCount;

        response.validation = {
            total_action_count: totalActionCount,
            transaction_count_from_blocks: transactionCountFromBlocks,
            is_valid: missingActions === 0,
            missing_actions: missingActions
        };
    }

    // Add grouped statistics if requested
    if (query.group_by && aggs.grouped_stats) {
        const groupedStats: any = {};

        if (query.group_by === 'producer') {
            aggs.grouped_stats.buckets?.forEach((bucket: any) => {
                groupedStats[bucket.key] = {
                    trx_count: bucket.trx_count_sum?.value || 0,
                    block_count: bucket.block_count?.value || 0,
                    avg_trx_per_block: bucket.block_count?.value > 0 ?
                        Math.round((bucket.trx_count_sum?.value / bucket.block_count?.value) * 100) / 100 : 0
                };
            });
        } else if (query.group_by === 'hour' || query.group_by === 'day') {
            aggs.grouped_stats.buckets?.forEach((bucket: any) => {
                const timeKey = new Date(bucket.key).toISOString();
                groupedStats[timeKey] = {
                    trx_count: bucket.trx_count_sum?.value || 0,
                    block_count: bucket.block_count?.value || 0,
                    avg_trx_per_block: bucket.block_count?.value > 0 ?
                        Math.round((bucket.trx_count_sum?.value / bucket.block_count?.value) * 100) / 100 : 0
                };
            });
        }

        response.grouped_stats = groupedStats;
    }

    return response;
}

export function getTrxCountHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getTrxCount, fastify, request, route));
    }
}
