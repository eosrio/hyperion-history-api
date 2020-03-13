import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import got from "got";
import {timedQuery} from "../../../helpers/functions";

async function getAccount(fastify: FastifyInstance, request: FastifyRequest) {

    const response = {
        query_time: null,
        cached: false,
        account: null,
        actions: null,
        tokens: null,
        links: null
    };

    const account = request.query.account;
    const reqQueue = [];
    reqQueue.push(fastify.eosjs.rpc.get_account(account));

    const localApi = `http://${fastify.manager.config.api.server_addr}:${fastify.manager.config.api.server_port}/v2`;
    const getTokensApi = localApi + '/state/get_tokens';
    const getActionsApi = localApi + '/history/get_actions';

    // fetch recent actions
    reqQueue.push(got.get(`${getActionsApi}?account=${account}&limit=10`));

    // fetch account tokens
    reqQueue.push(got.get(`${getTokensApi}?account=${account}`));

    const results = await Promise.all(reqQueue);
    response.account = results[0];
    response.actions = JSON.parse(results[1].body).actions;
    response.tokens = JSON.parse(results[2].body).tokens;
    return response;
}

export function getAccountHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getAccount, fastify, request, route));
    }
}
