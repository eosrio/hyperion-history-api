import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {getTrackTotalHits, mergeActionMeta, timedQuery} from "../../../helpers/functions.js";
import {
    addSortedBy,
    applyAccountFilters,
    applyCodeActionFilters,
    applyGenericFilters,
    applyTimeFilter,
    getSkipLimit,
    getSortDir
} from "./functions.js";
import {estypes} from "@elastic/elasticsearch";
import {HyperionAction} from "../../../../interfaces/hyperion-action.js";
import {Serialize} from "enf-eosjs";

async function getActions(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const maxActions = fastify.manager.config.api.limits.get_actions;
    const queryStruct: estypes.QueryDslQueryContainer = {
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

    const esResults = await fastify.elastic.search<HyperionAction>({
        "index": indexPattern,
        "from": skip || 0,
        "size": (maxActions && (limit > maxActions) ? maxActions : limit) || 10,
        ...query_body
    });

    console.log(esResults);

    const results = esResults.hits;
    const response: any = {
        cached: false,
        lib: 0,
        total: results.total
    };

    if (query.hot_only) {
        response.hot_only = true;
    }

    if (query.checkLib) {
        response.lib = (await fastify.eosjs.rpc.get_info()).last_irreversible_block_num;
    }

    if (query.simple) {
        response.simple_actions = [];
    } else {
        response.actions = [];
    }

    if (results.hits.length > 0) {
        const actions = results.hits;
        for (let action of actions) {
            if (action._source) {
                const source = action._source;
                mergeActionMeta(action);
                if (query.noBinary === true) {
                    for (const key in source.act.data) {
                        if (source.act.data.hasOwnProperty(key)) {
                            if (typeof source.act.data[key] === 'string' && source.act.data[key].length > 256) {
                                source.act.data[key] = source.act.data[key].slice(0, 32) + "...";
                            }
                        }
                    }
                }

                if (query.simple) {
                    response.simple_actions.push({
                        block: source.block_num,
                        irreversible: response.lib !== 0 ? source.block_num < response.lib : undefined,
                        timestamp: source["@timestamp"],
                        transaction_id: source.trx_id,
                        actors: source.act.authorization.map((a: Serialize.Authorization) => {
                            return `${a.actor}@${a.permission}`;
                        }).join(","),
                        notified: source.notified.join(','),
                        contract: source.act.account,
                        action: source.act.name,
                        data: source.act.data
                    });

                } else {
                    response.actions.push(source);
                }
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
