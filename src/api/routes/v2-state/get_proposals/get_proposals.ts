import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";

async function getProposals(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;

    let skip: number;
    let limit: number;
    skip = parseInt(query.skip, 10);
    if (skip < 0) {
        return 'invalid skip parameter';
    }
    limit = parseInt(query.limit, 10);
    if (limit < 1) {
        return 'invalid limit parameter';
    }

    const maxDocs = fastify.manager.config.api.limits.get_proposals ?? 100;

    const response: any = {
        query_time_ms: 0,
        cached: false,
        total: 0,
        proposals: [],
        last_indexed_block: 0,
        last_indexed_block_time: ''
    };

    let stateResult: any[];
    const startTime = Date.now();

    const dbName = `${fastify.manager.conn.mongodb.database_prefix}_${fastify.manager.chain}`;
    const collection = fastify.mongo.client.db(dbName).collection('proposals');

    const mongoQuery: any = {};
    if (query.account) {
        const accounts = query.account.split(',');
        mongoQuery.$or = [
            {"requested_approvals.actor": {$in: accounts}},
            {"provided_approvals.actor": {$in: accounts}}
        ];
    }
    if (query.proposer) {
        mongoQuery.proposer = query.proposer;
    }
    if (query.proposal) {
        mongoQuery.proposal_name = query.proposal;
    }
    if (typeof query.executed !== 'undefined') {
        mongoQuery.executed = query.executed;
    }

    const currentDate = new Date();
    if (query.expired === "true") {
        mongoQuery.expiration = {$lt: currentDate};
    } else if (query.expired === "false") {
        mongoQuery.expiration = {$gte: currentDate};
    }

    if (query.requested) {
        mongoQuery["requested_approvals.actor"] = query.requested;
    }
    if (query.provided) {
        mongoQuery["provided_approvals.actor"] = query.provided;
    }

    const lastBlockResult = await fastify.mongo.client
        .db(dbName)
        .collection('proposals')
        .find()
        .sort({expiration: -1})
        .limit(1)
        .toArray();

    response.last_indexed_block = lastBlockResult[0]?.block_num || 0;
    response.last_indexed_block_time = lastBlockResult[0]?.block_time || '';

    response.total = {value: await collection.countDocuments(mongoQuery), relation: "eq"};
    stateResult = await collection.find(mongoQuery).skip(skip || 0).limit(limit || 50).toArray();

    for (const proposal of stateResult) {
        response.proposals.push(proposal);
    }

    response.query_time_ms = Date.now() - startTime;
    return response;
}

export function getProposalsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getProposals, fastify, request, route));
    };
}
