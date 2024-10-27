import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {createHash} from "crypto";
import {base58ToBinary, binaryToBase58} from "eosjs/dist/eosjs-numeric.js";

function convertToLegacyKey(block_signing_key: string) {
    if (block_signing_key.startsWith("PUB_K1_")) {
        const buf = base58ToBinary(37, block_signing_key.substring(7));
        const data = buf.slice(0, buf.length - 4);
        const merged = Buffer.concat([
            data,
            createHash('ripemd160')
                .update(data)
                .digest()
                .subarray(0, 4)
        ]);
        return "EOS" + binaryToBase58(merged);
    } else {
        return block_signing_key;
    }
}

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
        const results = apiResponse.hits.hits;
        if (results && results.length > 0) {
            response.timestamp = results[0]._source["@timestamp"];
            response.block_num = results[0]._source.block_num;
            response.version = results[0]._source.new_producers.version;
            response.producers = results[0]._source.new_producers.producers.map((prod: any) => {
                return {
                    ...prod,
                    legacy_key: convertToLegacyKey(prod.block_signing_key)
                }
            });
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
            // sort producers by name
            // response.producers.sort((a, b) => {
            //     if (a.name < b.name) {
            //         return -1;
            //     }
            //     if (a.name > b.name) {
            //         return 1;
            //     }
            //     return 0;
            // });
        }
    }
    return response;
}

export function getScheduleHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getSchedule, fastify, request, route));
    }
}
