import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timedQuery } from "../../../helpers/functions.js";
import { getSkipLimit } from "../../v2-history/get_actions/functions.js";
import { IAccount } from "../../../../interfaces/table-account.js";
import { Asset } from "@wharfkit/antelope";


async function getTokens(fastify: FastifyInstance, request: FastifyRequest) {

    const query: any = request.query;

    const response: any = {
        account: query.account,
        tokens: []
    };

    let { skip, limit } = getSkipLimit(request.query);
    const maxDocs = fastify.manager.config.api.limits.get_tokens ?? 100;

    // Check if MongoDB is enabled
    if (!fastify.manager.conn.mongodb || fastify.manager.conn.mongodb.enabled === false) {
        return {
            error: 'MongoDB is disabled. Please enable MongoDB in config/connections.json to use this endpoint.'
        };
    }

    // Check if limit is above maximum allowed
    if (limit && limit > maxDocs) {
        limit = maxDocs;
    }

    let stateResult: IAccount[];

    const dbName = `${fastify.manager.conn.mongodb.database_prefix}_${fastify.manager.chain}`;
    const collection = fastify.mongo.client.db(dbName).collection<IAccount>('accounts');
    stateResult = await collection
        .find({ scope: query.account }, { projection: { _id: 0, code: 1, symbol: 1, amount: 1 } })
        .skip(skip || 0)
        .limit(limit || 50)
        .toArray();


    const testSet = new Set();
    for (const data of stateResult) {
        let precision;
        let token_data: Asset[];
        let errorMsg;

        const key = `${data.code}_${data.symbol}`;

        if (testSet.has(key)) {
            continue;
        }

        testSet.add(key);
        if (!fastify.tokenCache) {
            fastify.tokenCache = new Map<string, any>();
        }
        if (fastify.tokenCache.has(key)) {
            precision = fastify.tokenCache.get(key).precision;
        } else {
            try {
                token_data = await fastify.antelope.chain.get_currency_balance(data.code, query.account, data.symbol);
                if (token_data.length > 0) {
                    const amount = token_data[0].quantity;
                    const amount_arr = amount.split(".");
                    if (amount_arr.length === 2) {
                        precision = amount_arr[1].length;
                        fastify.tokenCache.set(key, { precision });
                    }
                }
            } catch (e: any) {
                errorMsg = e.message;
            }
        }

        const resp: Record<string, any> = {
            symbol: data.symbol,
            precision: precision,
            amount: parseFloat(data.amount as string),
            contract: data.code,
        };

        if (errorMsg) {
            resp.error = errorMsg;
        }

        response.tokens.push(resp);
    }

    return response;
}

export function getTokensHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getTokens, fastify, request, route));
    }
}
