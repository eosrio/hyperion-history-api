import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeDeltaMeta, timedQuery} from "../../../helpers/functions.js";
import {ActionIndexSource, DeltaIndexSource} from "../../../../interfaces/es-interfaces.js";

async function getTableState(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const response = {
        ...query,
        results: [],
        next_key: null
    };
    const mustArray: any[] = [
        {"term": {"code": query.code}},
        {"term": {"table": query.table}}
    ];
    if (query.block_num) {
        mustArray.push({"range": {"block_num": {"lte": query.block_num}}});
    }
    let after_key = "";
    if (query.after_key) {
        after_key = query.after_key;
    }
    const results = await fastify.elastic.search<DeltaIndexSource, any>({
        index: fastify.manager.chain + '-delta-*',
        "query": {
            "bool": {
                "must": mustArray
            }
        },
        "size": 0,
        "sort": [
            "block_num:desc",
            "primary_key:desc"
        ],
        "aggs": {
            "scope_buckets": {
                "composite": {
                    "size": 25,
                    "after": {
                        "scope_pk": after_key
                    },
                    "sources": [
                        {
                            "scope_pk": {
                                "terms": {
                                    "script": {
                                        "source": "return doc['scope'].value + '-' + doc['primary_key'].value",
                                        "lang": "painless"
                                    }
                                }
                            }
                        }
                    ]
                },
                "aggs": {
                    "last_doc": {
                        "top_hits": {
                            "size": 1,
                            "sort": [{"block_num": "desc"}],
                            "_source": {
                                "excludes": ["code"]
                            }
                        }
                    }
                }
            }
        }
    });
    const scope_buckets = results.aggregations.scope_buckets;
    if (scope_buckets && scope_buckets.buckets.length > 0) {
        if (scope_buckets.after_key) {
            response.next_key = scope_buckets.after_key.scope_pk;
        }
        response.results = scope_buckets.buckets.map(bucket => {
            const row = mergeDeltaMeta(bucket.last_doc.hits.hits[0]._source);
            delete row.table;
            return row;
        });
    }
    return response;
}

export function getTableStateHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getTableState, fastify, request, route));
    }
}
