import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import {getTrackTotalHits, mergeActionMeta, timedQuery} from "../../../helpers/functions";
import {
    addSortedBy,
    applyAccountFilters,
    applyCodeActionFilters,
    applyGenericFilters,
    applyTimeFilter,
    getSkipLimit,
    getSortDir
} from "./functions";

async function getActions(fastify: FastifyInstance, request: FastifyRequest) {
    const query = request.query;
    const queryStruct = {
        "bool": {
            must: [],
            must_not: [],
            boost: 1.0
        }
    };

    const {skip, limit} = getSkipLimit(query);
    const sort_direction = getSortDir(query);
    applyAccountFilters(query, queryStruct);
    applyGenericFilters(query, queryStruct);
    applyTimeFilter(query, queryStruct);
    applyCodeActionFilters(query, queryStruct);
    // allow precise counting of total hits
    const trackTotalHits = getTrackTotalHits(query);

    // Prepare query body
    const query_body = {
        "track_total_hits": trackTotalHits,
        "query": queryStruct
    };

    // Include sorting
    addSortedBy(query, query_body, sort_direction);

    // Perform search
    const maxActions = fastify.manager.config.api.limits.get_actions;
    const pResults = await Promise.all([
        fastify.eosjs.rpc.get_info(),
        fastify.elastic.search({
            "index": fastify.manager.chain + '-action-*',
            "from": skip || 0,
            "size": (limit > maxActions ? maxActions : limit) || 10,
            "body": query_body
        })
    ]);

    const results = pResults[1]['body']['hits'];
    const response: any = {
        cached: false,
        lib: pResults[0].last_irreversible_block_num,
        total: results['total']
    };

    if (query.simple) {
        response['simple_actions'] = [];
    } else {
        response['actions'] = [];
    }

    if (results['hits'].length > 0) {
        const actions = results['hits'];
        for (let action of actions) {
            action = action._source;
            mergeActionMeta(action);
            if (query.simple) {
                response.simple_actions.push({
                    block: action['block_num'],
                    irreversible: action['block_num'] < pResults[0].last_irreversible_block_num,
                    timestamp: action['@timestamp'],
                    transaction_id: action['trx_id'],
                    actors: action['act']['authorization'].map(a => `${a.actor}@${a.permission}`).join(","),
                    notified: action['notified'].join(','),
                    contract: action['act']['account'],
                    action: action['act']['name'],
                    data: action['act']['data']
                });
            } else {
                response.actions.push(action);
            }
        }
    }
    return response;
}

export function getActionsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getActions, fastify, request, route));
    }
}
