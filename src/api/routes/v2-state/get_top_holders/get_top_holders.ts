import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timedQuery } from "../../../helpers/functions.js";
import { getSkipLimit } from "../../v2-history/get_actions/functions.js";

async function getTopHolders(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;

    const response: any = {
        contract: query.account,
        symbol: undefined,
        holders: []
    };

    const { skip, limit } = getSkipLimit(request.query);

    const maxDocs = fastify.manager.config.api.limits.get_top_holders ?? 500;

    // Check if MongoDB is enabled
    if (!fastify.manager.conn.mongodb || fastify.manager.conn.mongodb.enabled === false) {
        return {
            error: 'MongoDB is disabled. Please enable MongoDB in config/connections.json to use this endpoint.'
        };
    }

    const dbName = `${fastify.manager.conn.mongodb.database_prefix}_${fastify.manager.chain}`;
    const collection = fastify.mongo.client.db(dbName).collection('accounts');

    const mongoQuery: any = {};
    if (query.contract) {
        mongoQuery.code = query.contract;
    }
    if (query.symbol) {
        mongoQuery.symbol = query.symbol;
    }

    response.holders = await collection
        .find(mongoQuery)
        .sort({ amount: -1 })
        .skip(skip || 0)
        .limit((limit > maxDocs ? maxDocs : limit) || 50)
        .toArray();

    response.holders = response.holders.map((doc: any) => ({
        owner: doc.scope,
        amount: doc.amount,
        symbol: doc.symbol,
        updated_on: doc.block_num
    }));

    return response;
}

export function getTopHoldersHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getTopHolders, fastify, request, route));
    }
}
