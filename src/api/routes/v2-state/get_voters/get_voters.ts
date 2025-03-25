import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {getSkipLimit} from "../../v2-history/get_actions/functions.js";

import {estypes} from "@elastic/elasticsearch";
import {IVoter} from "../../../../interfaces/table-voter.js";

async function getVoters(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const {skip, limit} = getSkipLimit(request.query);
    const maxDocs = fastify.manager.config.api.limits.get_voters ?? 100;

    const response: any = {
        voter_count: 0,
        voters: []
    };

    let stateResult: IVoter[];

    if (fastify.manager.config.indexer.experimental_mongodb_state && fastify.manager.conn.mongodb && query.useMongo === 'true') {
        const dbName = `${fastify.manager.conn.mongodb.database_prefix}_${fastify.manager.chain}`;
        const collection = fastify.mongo.client.db(dbName).collection<IVoter>('voters');

        const mongoQuery: any = {};
        if (query.producer) {
            mongoQuery.producers = {$all: query.producer.split(",")};
        }

        if (query.is_proxy === 'true') {
            mongoQuery.is_proxy = true;
        }

        response.voter_count = await collection.countDocuments(mongoQuery);

        stateResult = await collection
            .find(mongoQuery, {
                projection: {
                    _id: 0,
                    voter: 1,
                    last_vote_weight: 1,
                    is_proxy: 1,
                    block_num: 1,
                    staked: 1,
                    producers: query.listProducers === 'true' ? 1 : undefined
                }
            })
            .skip(skip || 0)
            .limit(limit || 50)
            .toArray();

    } else {

        let queryStruct: any = {bool: {must: []}};
        if (query.producer) {
            for (const bp of query.producer.split(",")) {
                queryStruct.bool.must.push({term: {producers: bp}});
            }
        }
        if (query.proxy === 'true') {
            queryStruct.bool.must.push({term: {is_proxy: true}});
        }
        if (queryStruct.bool.must.length === 0) {
            queryStruct = {match_all: {}};
        }

        const esResult = await fastify.elastic.search<any>({
            index: `${fastify.manager.chain}-table-voters-*`,
            from: skip || 0,
            size: (limit > maxDocs ? maxDocs : limit) || 10,
            query: queryStruct,
            sort: [{last_vote_weight: "desc"}]
        });
        stateResult = esResult.hits.hits.map((hit: any) => hit._source);
        response.voter_count = (esResult.hits.total as estypes.SearchTotalHits).value;
    }

    for (const voter of stateResult) {
        response.voters.push({
            account: voter.voter,
            weight: voter.last_vote_weight,
            staked: voter.staked,
            is_proxy: voter.is_proxy,
            last_vote_block: voter.block_num,
            producers: voter.producers || undefined
        });
    }

    return response;
}

export function getVotersHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getVoters, fastify, request, route));
    };
}
