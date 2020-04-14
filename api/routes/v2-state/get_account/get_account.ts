import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import got from "got";
import {timedQuery} from "../../../helpers/functions";

async function getAccount(fastify: FastifyInstance, request: FastifyRequest) {

    const response = {
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
    const getLinksApi = localApi + '/state/get_links';

    // fetch recent actions
    reqQueue.push(got.get(`${getActionsApi}?account=${account}&limit=10`).json());

    // fetch account tokens
    reqQueue.push(got.get(`${getTokensApi}?account=${account}`).json());

    // fetch account permission links
    reqQueue.push(got.get(`${getLinksApi}?account=${account}`).json());

    const results = await Promise.all(reqQueue);
    response.account = results[0];
    response.actions = results[1].actions;
    response.tokens = results[2].tokens;
    response.links = results[3].links;
    return response;
}

export function getAccountHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getAccount, fastify, request, route));
    }
}
