import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions";

function filterToObj(chain: string, type: string, filters: string[]): {
    contract: string,
    action?: string,
    table?: string
}[] {
    return filters
        .filter(value => value.startsWith(chain))
        .map((item) => {
            const parts = item.split("::");
            switch (type) {
                case 'action': {
                    return {
                        contract: parts[1],
                        action: parts[2]
                    }
                }
                case 'delta': {
                    return {
                        contract: parts[1],
                        table: parts[2]
                    }
                }
            }
        });
}

async function getFilters(fastify: FastifyInstance) {
    const blacklists = fastify.manager.config.blacklists;
    const whitelists = fastify.manager.config.whitelists;
    let isWhitelisted = false;

    let includes = {
        actions: [],
        deltas: []
    };

    if (whitelists.actions.length > 0) {
        isWhitelisted = true;
        includes.actions = filterToObj(fastify.manager.chain, 'action', whitelists.actions);
    }

    if (whitelists.deltas.length > 0) {
        isWhitelisted = true;
        includes.deltas = filterToObj(fastify.manager.chain, 'delta', whitelists.deltas);
    }

    let excludes = {
        actions: [],
        deltas: []
    };

    if (blacklists.actions.length > 0) {
        excludes.actions = filterToObj(fastify.manager.chain, 'action', blacklists.actions);
    }

    if (blacklists.deltas.length > 0) {
        excludes.deltas = filterToObj(fastify.manager.chain, 'delta', blacklists.deltas);
    }

    return {isWhitelisted, excludes, includes};
}

export function getFiltersHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getFilters, fastify, request, route));
    }
}