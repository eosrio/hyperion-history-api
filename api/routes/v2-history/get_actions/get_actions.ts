import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
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
    const query: any = request.query;
    const maxActions = fastify.manager.config.api.limits.get_actions;
    const queryStruct = {
        "bool": {
            must: [],
            must_not: [],
            boost: 1.0
        }
    };

    const {skip, limit} = getSkipLimit(query, maxActions);

    const sort_direction = getSortDir(query);

    applyAccountFilters(query, queryStruct);

    applyGenericFilters(query, queryStruct, fastify.allowedActionQueryParamSet);

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

    let indexPattern = fastify.manager.chain + '-action-*';
    if (query.hot_only) {
        indexPattern = fastify.manager.chain + '-action';
    }

    const esResults = await fastify.elastic.search({
        "index": indexPattern,
        "from": skip || 0,
        "size": (limit > maxActions ? maxActions : limit) || 10,
        "body": query_body
    });

    const results = esResults['body']['hits'];
    const response: any = {
        cached: false,
        lib: 0,
        total: results['total']
    };

    if (query.hot_only) {
        response.hot_only = true;
    }

    if (query.checkLib) {
        response.lib = (await fastify.eosjs.rpc.get_info()).last_irreversible_block_num;
    }

    if (query.simple) {
        response['simple_actions'] = [];
    } else {
        response['actions'] = [];
    }

    if (results['hits'].length > 0) {
        const actions = results['hits'];
        for (let action of actions.map(a => a._source)) {

            try {
                if (action.act.data) {
                    if (action.act.data.account && action.act.data.name && action.act.data.authorization) {
                        action.act.data = action.act.data.data;
                    }
                }
            } catch (e: any) {
                console.log(e);
            }

            mergeActionMeta(action);

            if (query.noBinary === true) {
                for (const key in action['act']['data']) {
                    if (action['act']['data'].hasOwnProperty(key)) {
                        if (typeof action['act']['data'][key] === 'string' && action['act']['data'][key].length > 256) {
                            action['act']['data'][key] = action['act']['data'][key].slice(0, 32) + "...";
                        }
                    }
                }
            }

            if (query.simple) {
                let notified = new Set(action.receipts.map(r => r.receiver));
                response.simple_actions.push({
                    block: action['block_num'],
                    irreversible: response.lib !== 0 ? action['block_num'] < response.lib : undefined,
                    timestamp: action['@timestamp'],
                    transaction_id: action['trx_id'],
                    actors: action['act']['authorization'].map(a => `${a.actor}@${a.permission}`).join(","),
                    notified: [...notified].join(','),
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
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getActions, fastify, request, route));
    }
}
