import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {getTrackTotalHits, timedQuery} from "../../../helpers/functions";

async function getProposals(fastify: FastifyInstance, request: FastifyRequest) {

    const query: any = request.query;

    // Pagination
    let skip: number;
    let limit: number;
    skip = parseInt(query.skip, 10);
    if (skip < 0) {
        return 'invalid skip parameter';
    }
    limit = parseInt(query.limit, 10);
    if (limit < 1) {
        return 'invalid limit parameter';
    }

    let queryStruct: any = {
        "bool": {
            "must": []
        }
    };

    // Filter by accounts
    if (query.account) {
        const accounts = query.account.split(',');
        for(const acc of accounts) {
            queryStruct.bool.must.push({
                "bool": {
                    "should": [
                        {"term": {"requested_approvals.actor": acc}},
                        {"term": {"provided_approvals.actor": acc}}
                    ]
                }
            });
        }
    }

    // Filter by proposer account
    if (query.proposer) {
        queryStruct.bool.must.push({"term": {"proposer": query.proposer}});
    }

    // Filter by proposal name
    if (query.proposal) {
        queryStruct.bool.must.push({"term": {"proposal_name": query.proposal}});
    }

    // Filter by execution status
    if (typeof query.executed !== 'undefined') {
        queryStruct.bool.must.push({"term": {"executed": query.executed}});
    }

    // Filter by requested actors
    if (query.requested) {
        queryStruct.bool.must.push({"term": {"requested_approvals.actor": query.requested}});
    }

    // Filter by provided actors
    if (query.provided) {
        queryStruct.bool.must.push({"term": {"provided_approvals.actor": query.provided}});
    }

    // If no filter switch to full match
    if (queryStruct.bool.must.length === 0) {
        queryStruct = {
            "match_all": {}
        };
    }

    const maxDocs = fastify.manager.config.api.limits.get_proposals ?? 100;
    const results = await fastify.elastic.search<any>({
        "index": fastify.manager.chain + '-table-proposals-*',
        "from": skip || 0,
        "size": (limit > maxDocs ? maxDocs : limit) || 10,
        "track_total_hits": getTrackTotalHits(request.query),
        "query": queryStruct,
        "sort": [{"block_num": "desc"}]
    });

    const response: any = {
        query_time: null,
        cached: false,
        total: results.hits.total,
        proposals: []
    };

    const hits = results.hits.hits;
    for (const hit of hits) {
        const prop = hit._source;
        response.proposals.push(prop);
    }

    return response;
}

export function getProposalsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getProposals, fastify, request, route));
    }
}
