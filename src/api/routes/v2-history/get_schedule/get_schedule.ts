import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";

async function getSchedule(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const response: any = {
        producers: []
    };
    if (query.mode === 'activated') {
        const searchParams: any = {
            track_total_hits: true,
            index: fastify.manager.chain + "-block-*",
            size: 1,
            query: {bool: {must: []}},
            sort: {block_num: query.sort || "desc"}
        };
        if (query.version) {
            searchParams.query.bool.must.push({"term": {"new_producers.version": {"value": query.version}}});
        } else {
            searchParams.query.bool.must.push({"exists": {"field": "new_producers.version"}});
        }
        const apiResponse = await fastify.elastic.search<any>(searchParams);
        console.dir(apiResponse, {depth: 5});
        const results = apiResponse.hits.hits;
        if (results && results.length > 0) {
            response.timestamp = results[0]._source["@timestamp"];
            response.block_num = results[0]._source.block_num;
            response.version = results[0]._source.new_producers.version;
            response.producers = results[0]._source.new_producers.producers;
        }
    } else {
        // default "proposed" mode
        const searchParams: any = {
            track_total_hits: true,
            index: fastify.manager.chain + "-schedule-*",
            size: 1,
            query: {bool: {must: []}},
            sort: {version: query.sort || "desc"}
        };
        if (query.version) {
            searchParams.query.bool.must.push({"term": {"version": {"value": query.version}}});
        } else {
            searchParams.query.bool.must.push({"exists": {"field": "version"}});
        }
        if (query.producer) {
            searchParams.query.bool.must.push({"term": {"producers.name": {"value": query.producer}}});
        }
        if (query.key) {
            searchParams.query.bool.must.push({"term": {"producers.keys": {"value": query.key}}});
        }
        const apiResponse = await fastify.elastic.search<any>(searchParams);
        const results = apiResponse.hits.hits;
        if (results && results.length > 0) {
            response.timestamp = results[0]._source["@timestamp"];
            response.proposal_block_num = results[0]._source.block_num;
            response.version = results[0]._source.version;
            response.producers = results[0]._source.producers;
        }
    }
    return response;
}

export function getScheduleHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getSchedule, fastify, request, route));
    }
}
