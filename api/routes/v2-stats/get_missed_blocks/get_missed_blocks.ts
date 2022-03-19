import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions";
import {applyTimeFilter} from "../../v2-history/get_actions/functions";
import {LogsIndexSource} from "../../../../interfaces/es-interfaces";
import {SearchRequest} from "@elastic/elasticsearch/lib/api/types";
import {isArray} from "lodash";

async function getMissedBlocks(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const response = {
        stats: {
            by_producer: {}
        },
        events: []
    };
    const searchParams: SearchRequest = {
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
    if (isArray(searchParams.query.bool.must)) {
        if (query.min_blocks) {
            minBlocks = parseInt(query.min_blocks);
            searchParams.query.bool.must.push({range: {"missed_blocks.size": {gte: minBlocks}}})

        }
        if (query.producer) {
            searchParams.query.bool.must.push({term: {"missed_blocks.producer": query.producer}});
        }
    }

    applyTimeFilter(query, searchParams.query);

    const apiResponse = await fastify.elastic.search<LogsIndexSource>(searchParams);
    apiResponse.hits.hits.forEach(v => {
        const ev = v._source;
        response.events.push({
            "@timestamp": ev["@timestamp"],
            ...ev.missed_blocks
        });
        if (!response.stats.by_producer[ev.missed_blocks.producer]) {
            response.stats.by_producer[ev.missed_blocks.producer] = ev.missed_blocks.size;
        } else {
            response.stats.by_producer[ev.missed_blocks.producer] += ev.missed_blocks.size;
        }
    });
    return response;
}

export function getMissedBlocksHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getMissedBlocks, fastify, request, route));
    }
}
