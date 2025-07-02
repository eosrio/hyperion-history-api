import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";

async function getAbiSnapshot(fastify: FastifyInstance, request: FastifyRequest) {

    const response = {
        block_num: null
    };

    const query: any = request.query;

    const code = query.contract;
    const block = query.block;
    const should_fetch = query.fetch;

    const mustArray: any[] = [];

    mustArray.push({"term": {"account": code}});

    if (block) {
        mustArray.push({"range": {"block": {"lte": parseInt(block)}}});
    }

    const results = await fastify.elastic.search<any>({
        index: fastify.manager.chain + '-abi-*',
        size: 1,
        query: {bool: {must: mustArray}},
        sort: [{block: {order: "desc"}}]
    });
    if (results.hits.hits.length > 0) {
        if (should_fetch) {
            response['abi'] = JSON.parse(results.hits.hits[0]['_source']['abi']);
        } else {
            response['present'] = true;
        }
        response.block_num = results.hits.hits[0]['_source']['block'];
    } else {
        response['present'] = false;
        response['error'] = 'abi not found for ' + code + ' until block ' + block;
    }

    return response;
}

export function getAbiSnapshotHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getAbiSnapshot, fastify, request, route));
    }
}
