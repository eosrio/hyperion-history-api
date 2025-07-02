import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeDeltaMeta, timedQuery} from "../../../helpers/functions.js";
import {applyTimeFilter} from "../get_actions/functions.js";
import {estypes} from "@elastic/elasticsearch";

async function getDeltas(fastify: FastifyInstance, request: FastifyRequest) {
    let skip: number | undefined;
    let limit: number = 10;
    let sort_direction: estypes.SortOrder = 'desc';
    const mustArray: any[] = [];
    const query: any = request.query;
    for (const param in query) {
        if (Object.prototype.hasOwnProperty.call(query, param)) {
            const value = query[param];
            switch (param) {
                case 'limit': {
                    limit = parseInt(value, 10);
                    if (limit < 1) {
                        return 'invalid limit parameter';
                    }
                    break;
                }
                case 'skip': {
                    skip = parseInt(value, 10);
                    if (skip < 0) {
                        return 'invalid skip parameter';
                    }
                    break;
                }
                case 'sort': {
                    if (value === 'asc' || value === '1') {
                        sort_direction = 'asc';
                    } else if (value === 'desc' || value === '-1') {
                        sort_direction = 'desc'
                    } else {
                        return 'invalid sort direction';
                    }
                    break;
                }
                case 'before': {
                    break;
                }
                case 'after': {
                    break;
                }
                default: {
                    if (typeof value === 'string') {
                        const values = query[param].split(",");
                        if (values.length > 1) {
                            const terms = {};
                            terms[param] = values;
                            mustArray.push({terms: terms});
                        } else {
                            const term = {};
                            term[param] = values[0];
                            mustArray.push({term: term});
                        }
                    } else {
                        if (typeof value === 'number') {
                            const term = {};
                            term[param] = value;
                            mustArray.push({term: term});
                        }
                    }
                    break;
                }
            }
        }
    }

    const maxDeltas = fastify.manager.config.api.limits.get_deltas ?? 1000;
    const queryStruct = {bool: {must: mustArray}};

    applyTimeFilter(query, queryStruct);

    const results = await fastify.elastic.search<any>({
        "index": fastify.manager.chain + '-delta-*',
        "from": skip || 0,
        "size": (limit > maxDeltas ? maxDeltas : limit) || 10,
        query: queryStruct,
        sort: [{block_num: {order: sort_direction}}]
    });
    const deltas = results.hits.hits.map((d: any) => {
        return mergeDeltaMeta(d._source);
    });
    return {
        query_time: null,
        total: results.hits.total,
        deltas
    };
}

export function getDeltasHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getDeltas, fastify, request, route));
    }
}
