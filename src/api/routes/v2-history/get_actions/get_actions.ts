import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {getTrackTotalHits, mergeActionMeta, timedQuery} from "../../../helpers/functions.js";
import {resolveHotIndices} from "../../../helpers/hot-index.js";
import {
    addSortedBy,
    applyAccountFilters,
    applyCodeActionFilters,
    applyGenericFilters,
    applyTimeFilter,
    getSkipLimit,
    getSortDir
} from "./functions.js";

async function getActions(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const maxActions = fastify.manager.config.api.limits.get_actions ?? 0;
    const queryStruct = {
        "bool": {
            must: [],
            must_not: [],
            boost: 1.0
        }
    };

    const {skip, limit} = getSkipLimit(query, maxActions);

    const maxAscWindowDays = fastify.manager.config.api.max_asc_window_days || 90;
    const sort_direction = getSortDir(query, maxAscWindowDays);

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
    const fullPattern = fastify.manager.chain + '-action-*';
    const hotWindow = fastify.manager.config.api.hot_first_window ?? 2;

    let indexPattern = fullPattern;
    if (query.hot_only) {
        // hot_only restricts the search to the newest action partition(s), resolved from the live
        // index set. (The legacy `<chain>-action` alias this used to target is never created, so the
        // old behavior threw index_not_found; resolveHotIndices degrades to the wildcard on failure.)
        indexPattern = await resolveHotIndices(fastify, 'action', hotWindow);
    }

    const queryTimeout = fastify.manager.config.api.query_timeout || '10s';
    const size = (limit > maxActions ? maxActions : limit) || 10;
    const esOpts = {
        "index": indexPattern,
        "from": skip || 0,
        "size": size,
        "timeout": queryTimeout,
        ...query_body
    };

    // Hot-first routing (opt-in via api.hot_first_actions): an unbounded, newest-first account poll
    // only ever needs the most recent actions, which live in the newest partition(s). Search the hot
    // window first and widen to the full <chain>-action-* set only if it returns fewer than `size`
    // hits — so heavy pollers (e.g. account=eosio.token) never fan out across old/warm shards. Only
    // the default global_sequence-desc sort qualifies; bounded queries, pagination (skip>0), asc
    // sorts, custom sortedBy, and explicit hot_only stay on their existing path.
    const hotFirstEligible =
        fastify.manager.config.api.hot_first_actions === true &&
        !query.hot_only &&
        !!query.account &&
        !query.sortedBy &&
        sort_direction === 'desc' &&
        !query.after &&
        !query.before &&
        (skip || 0) === 0;

    let esResults;
    let hotFirstUsed = false;
    if (hotFirstEligible) {
        const hotIndex = await resolveHotIndices(fastify, 'action', hotWindow);
        esResults = await fastify.elastic.search<any>({...esOpts, index: hotIndex});
        if (esResults.hits.hits.length < size) {
            // The account is sparse within the hot window — widen to the full set for correctness.
            esResults = await fastify.elastic.search<any>(esOpts);
        } else {
            hotFirstUsed = true;
        }
    } else {
        esResults = await fastify.elastic.search<any>(esOpts);
    }

    const results = esResults.hits;
    const response: any = {
        cached: false,
        lib: 0,
        total: results['total']
    };

    if (query.hot_only) {
        response.hot_only = true;
    }
    if (hotFirstUsed) {
        response.hot_first = true;
    }

    if (query.checkLib) {
        response.lib = (await fastify.antelope.chain.get_info()).last_irreversible_block_num;
    }

    if (query.simple) {
        response['simple_actions'] = [];
    } else {
        response['actions'] = [];
    }

    if (results.hits.length > 0) {
        const actions = results.hits;
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
