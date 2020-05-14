import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import {timedQuery} from "../../../helpers/functions";
import {RequestParams} from "@elastic/elasticsearch";
import {createHash} from "crypto";
import {base58ToBinary, binaryToBase58} from "eosjs/dist/eosjs-numeric";

function convertToLegacyKey(block_signing_key: string) {
    if (block_signing_key.startsWith("PUB_K1_")) {
        const buf = base58ToBinary(37, block_signing_key.substr(7));
        const data = buf.slice(0, buf.length - 4);
        const merged = Buffer.concat([
            data,
            createHash('ripemd160')
                .update(data)
                .digest()
                .slice(0, 4)
        ]);
        return "EOS" + binaryToBase58(merged);
    } else {
        return block_signing_key;
    }
}

async function getSchedule(fastify: FastifyInstance, request: FastifyRequest) {
    const response: any = {
        producers: []
    };
    const searchParams: RequestParams.Search = {
        track_total_hits: true,
        index: fastify.manager.chain + "-block-*",
        size: 1,
        body: {
            query: {
                bool: {
                    must: []
                }
            },
            sort: {block_num: "desc"}
        }
    };
    if (request.query.version) {
        searchParams.body.query.bool.must.push({"term": {"new_producers.version": {"value": request.query.version}}});
    } else {
        searchParams.body.query.bool.must.push({
            "exists": {
                "field": "new_producers.version"
            }
        });
    }
    const apiResponse = await fastify.elastic.search(searchParams);
    const results = apiResponse.body.hits.hits;
    if (results) {
        response.timestamp = results[0]._source["@timestamp"];
        response.block_num = results[0]._source.block_num;
        response.version = results[0]._source.new_producers.version;
        response.producers = results[0]._source.new_producers.producers.map(prod => {
            return {
                ...prod,
                legacy_key: convertToLegacyKey(prod.block_signing_key)
            }
        });
    }
    return response;
}

export function getScheduleHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getSchedule, fastify, request, route));
    }
}
