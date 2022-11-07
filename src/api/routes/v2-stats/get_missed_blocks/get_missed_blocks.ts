import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {applyTimeFilter} from "../../v2-history/get_actions/functions.js";
import {LogsIndexSource} from "../../../../interfaces/es-interfaces.js";
import {estypes} from "@elastic/elasticsearch";
import {isArray} from "radash";

async function getMissedBlocks(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const response = {
        stats: {
            by_producer: {}
        },
        events: [] as any[]
    };
    const searchParams: estypes.SearchRequest = {
        track_total_hits: true,
        index: fastify.manager.chain + "-logs-*",
        size: 100,
        query: {
            bool: {
                must: [{term: {type: "missed_blocks"}}]
            }
        },
        sort: "@timestamp:desc"
    };

    let minBlocks = 0;
    if (searchParams && isArray(searchParams.query?.bool?.must)) {
        if (query.min_blocks) {
            minBlocks = parseInt(query.min_blocks);
            searchParams.query?.bool?.must.push({range: {"missed_blocks.size": {gte: minBlocks}}})

        }
        if (query.producer) {
            searchParams.query?.bool?.must.push({term: {"missed_blocks.producer": query.producer}});
        }
    }

    if (!searchParams.query) {
        return;
    }

    applyTimeFilter(query, searchParams.query);

    const apiResponse = await fastify.elastic.search<LogsIndexSource>(searchParams);
    apiResponse.hits.hits.forEach(v => {
        const ev = v._source;
        if (ev) {
            response.events.push({
                "@timestamp": ev["@timestamp"],
                ...ev.missed_blocks
            });
            if (!response.stats.by_producer[ev.missed_blocks.producer]) {
                response.stats.by_producer[ev.missed_blocks.producer] = ev.missed_blocks.size;
            } else {
                response.stats.by_producer[ev.missed_blocks.producer] += ev.missed_blocks.size;
            }
        }
    });
    return response;
}

export function getMissedBlocksHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getMissedBlocks, fastify, request, route));
    }
}
