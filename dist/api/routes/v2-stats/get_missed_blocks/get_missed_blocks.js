import { timedQuery } from "../../../helpers/functions.js";
import { applyTimeFilter } from "../../v2-history/get_actions/functions.js";
import { isArray } from "radash";
async function getMissedBlocks(fastify, request) {
    const query = request.query;
    const response = {
        stats: {
            by_producer: {}
        },
        events: []
    };
    const searchParams = {
        track_total_hits: true,
        index: fastify.manager.chain + "-logs-*",
        size: 100,
        query: {
            bool: {
                must: [{ term: { type: "missed_blocks" } }]
            }
        },
        sort: "@timestamp:desc"
    };
    let minBlocks = 0;
    if (searchParams && isArray(searchParams.query?.bool?.must)) {
        if (query.min_blocks) {
            minBlocks = parseInt(query.min_blocks);
            searchParams.query?.bool?.must.push({ range: { "missed_blocks.size": { gte: minBlocks } } });
        }
        if (query.producer) {
            searchParams.query?.bool?.must.push({ term: { "missed_blocks.producer": query.producer } });
        }
    }
    applyTimeFilter(query, searchParams.query);
    const apiResponse = await fastify.elastic.search(searchParams);
    apiResponse.hits.hits.forEach(v => {
        const ev = v._source;
        if (ev) {
            response.events.push({
                "@timestamp": ev["@timestamp"],
                ...ev.missed_blocks
            });
            if (!response.stats.by_producer[ev.missed_blocks.producer]) {
                response.stats.by_producer[ev.missed_blocks.producer] = ev.missed_blocks.size;
            }
            else {
                response.stats.by_producer[ev.missed_blocks.producer] += ev.missed_blocks.size;
            }
        }
    });
    return response;
}
export function getMissedBlocksHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(getMissedBlocks, fastify, request, route));
    };
}
