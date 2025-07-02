import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timedQuery } from '../../../helpers/functions.js';
import { getSkipLimit } from '../../v2-history/get_actions/functions.js';
import { IVoter } from '../../../../interfaces/table-voter.js';

async function getVoters(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const { skip, limit } = getSkipLimit(request.query);
    const maxDocs = fastify.manager.config.api.limits.get_voters ?? 100;

    // Check if MongoDB is enabled
    if (!fastify.manager.conn.mongodb || fastify.manager.conn.mongodb.enabled === false) {
        return {
            error: 'MongoDB is disabled. Please enable MongoDB in config/connections.json to use this endpoint.'
        };
    }

    // Check if voters feature is enabled
    if (fastify.manager.config.features?.tables?.voters === false) {
        return {
            error: 'Voters feature is disabled. Please enable "voters" in features.tables configuration in chains/CHAIN_NAME.config.json file to use this endpoint.'
        };
    }

    const response: any = {
        voter_count: 0,
        voters: []
    };

    let stateResult: IVoter[];

    const dbName = `${fastify.manager.conn.mongodb.database_prefix}_${fastify.manager.chain}`;
    const collection = fastify.mongo.client.db(dbName).collection<IVoter>('voters');

    const mongoQuery: any = {};
    if (query.producer) {
        mongoQuery.producers = { $all: query.producer.split(',') };
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
        // Check conditions that require direct response without timedQuery
        if (
            !fastify.manager.conn.mongodb ||
            fastify.manager.conn.mongodb.enabled === false ||
            fastify.manager.config.features?.tables?.voters === false
        ) {
            // Call directly without timedQuery to avoid response modification
            const result = await getVoters(fastify, request);
            reply.send(result);
            return;
        }
        reply.send(await timedQuery(getVoters, fastify, request, route));
    };
}
