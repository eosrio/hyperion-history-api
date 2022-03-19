import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeDeltaMeta, timedQuery} from "../../../helpers/functions";
import {applyTimeFilter} from "../get_actions/functions";

async function getDeltas(fastify: FastifyInstance, request: FastifyRequest) {
    let skip, limit;
    let sort_direction = 'desc';
    const mustArray = [];
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
                    break;
                }
            }
        }
    }

    const maxDeltas = fastify.manager.config.api.limits.get_deltas ?? 1000;
    const queryStruct = {bool: {must: mustArray}};

    applyTimeFilter(query, queryStruct);

    const results = await fastify.elastic.search({
        "index": fastify.manager.chain + '-delta-*',
        "from": skip || 0,
        "size": (limit > maxDeltas ? maxDeltas : limit) || 10,
        "body": {
            query: queryStruct,
            sort: "block_num:" + sort_direction
        }
    });
    const deltas = results['body']['hits']['hits'].map((d) => {
        return mergeDeltaMeta(d._source);
    });
    return {
        query_time: null,
        total: results['body']['hits']['total'],
        deltas
    };
}

export function getDeltasHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getDeltas, fastify, request, route));
    }
}
