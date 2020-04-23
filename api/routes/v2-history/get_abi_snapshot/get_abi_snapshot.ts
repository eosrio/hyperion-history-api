import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import {timedQuery} from "../../../helpers/functions";

async function getAbiSnapshot(fastify: FastifyInstance, request: FastifyRequest) {

    const response = {
        block_num: null
    };

    const code = request.query.contract;
    const block = request.query.block;
    const should_fetch = request.query.fetch;

    const mustArray = [];

    mustArray.push({"term": {"account": code}});

    if (block) {
        mustArray.push({"range": {"block": {"lte": parseInt(block)}}});
    }

    const results = await fastify.elastic.search({
        index: fastify.manager.chain + '-abi',
        size: 1,
        body: {
            query: {bool: {must: mustArray}},
            sort: [{block: {order: "desc"}}]
        }
    });
    if (results['body']['hits']['hits'].length > 0) {
        if (should_fetch) {
            response['abi'] = JSON.parse(results['body']['hits']['hits'][0]['_source']['abi']);
        } else {
            response['present'] = true;
        }
        response.block_num = results['body']['hits']['hits'][0]['_source']['block'];
    } else {
        response['present'] = false;
        response['error'] = 'abi not found for ' + code + ' until block ' + block;
    }

    return response;
}

export function getAbiSnapshotHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getAbiSnapshot, fastify, request, route));
    }
}
