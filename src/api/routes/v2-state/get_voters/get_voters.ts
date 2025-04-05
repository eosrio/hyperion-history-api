import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {getSkipLimit} from "../../v2-history/get_actions/functions.js";
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
