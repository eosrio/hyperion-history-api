import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import {getTrackTotalHits, timedQuery} from "../../../helpers/functions";

async function getProposals(fastify: FastifyInstance, request: FastifyRequest) {

    // Pagination
    let skip, limit;
    skip = parseInt(request.query.skip, 10);
    if (skip < 0) {
        return 'invalid skip parameter';
    }
    limit = parseInt(request.query.limit, 10);
    if (limit < 1) {
        return 'invalid limit parameter';
    }

    let queryStruct: any = {
        "bool": {
            "must": []
        }
    };

    // Filter by accounts
    if (request.query.account) {
        const accounts = request.query.account.split(',');
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
    if (request.query.proposer) {
        queryStruct.bool.must.push({"term": {"proposer": request.query.proposer}});
    }

    // Filter by proposal name
    if (request.query.proposal) {
        queryStruct.bool.must.push({"term": {"proposal_name": request.query.proposal}});
    }

    // Filter by execution status
    if (typeof request.query.executed !== 'undefined') {
        queryStruct.bool.must.push({"term": {"executed": request.query.executed}});
    }

    // Filter by requested actors
    if (request.query.requested) {
        queryStruct.bool.must.push({"term": {"requested_approvals.actor": request.query.requested}});
    }

    // Filter by provided actors
    if (request.query.provided) {
        queryStruct.bool.must.push({"term": {"provided_approvals.actor": request.query.provided}});
    }

    // If no filter switch to full match
    if (queryStruct.bool.must.length === 0) {
        queryStruct = {
            "match_all": {}
        };
    }

    const maxDocs = fastify.manager.config.api.limits.get_proposals ?? 100;
    const results = await fastify.elastic.search({
        "index": fastify.manager.chain + '-table-proposals-*',
        "from": skip || 0,
        "size": (limit > maxDocs ? maxDocs : limit) || 10,
        "body": {
            "track_total_hits": getTrackTotalHits(request.query),
            "query": queryStruct,
            "sort": [{"block_num": "desc"}]
        }
    });

    const response = {
        query_time: null,
        cached: false,
        total: results['body']['hits']['total'],
        proposals: []
    };

    const hits = results['body']['hits']['hits'];
    for (const hit of hits) {
        const prop = hit._source;
        response.proposals.push(prop);
    }

    return response;
}

export function getProposalsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getProposals, fastify, request, route));
    }
}
