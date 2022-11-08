import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {createHash} from "crypto";
import {Numeric} from "enf-eosjs";

function convertToLegacyKey(block_signing_key: string) {
    if (block_signing_key.startsWith("PUB_K1_")) {
        const buf = Numeric.base58ToBinary(37, block_signing_key.substring(7));
        const data = buf.slice(0, buf.length - 4);
        const merged = Buffer.concat([
            data,
            createHash('ripemd160')
                .update(data)
                .digest()
                .subarray(0, 4)
        ]);
        return "EOS" + Numeric.binaryToBase58(merged);
    } else {
        return block_signing_key;
    }
}

async function getSchedule(fastify: FastifyInstance, request: FastifyRequest) {

    const query: any = request.query;

    const response: any = {
        producers: []
    };
    const searchParams: any = {
        track_total_hits: true,
        index: fastify.manager.chain + "-block-*",
        size: 1,
        query: {
            bool: {
                must: []
            }
        },
        sort: ["block_num:desc"]
    };
    if (query.version) {
        searchParams.query.bool.must.push({"term": {"new_producers.version": {"value": query.version}}});
    } else {
        searchParams.query.bool.must.push({
            "exists": {
                "field": "new_producers.version"
            }
        });
    }
    const apiResponse = await fastify.elastic.search<any>(searchParams);
    const results = apiResponse.hits.hits;
    if (results) {
        response.timestamp = results[0]._source["@timestamp"];
        response.block_num = results[0]._source.block_num;
        response.version = results[0]._source.new_producers.version;
        response.producers = results[0]._source.new_producers.producers.map((prod: any) => {
                return {
                    ...prod,
                    legacy_key: convertToLegacyKey(prod.block_signing_key)
                }
            }
        )
        ;
    }
    return response;
}

export function getScheduleHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getSchedule, fastify, request, route));
    }
}
