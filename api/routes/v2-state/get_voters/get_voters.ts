import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions";
import {getSkipLimit} from "../../v2-history/get_actions/functions";

async function getVoters(fastify: FastifyInstance, request: FastifyRequest) {

	const query: any = request.query;
	const {skip, limit} = getSkipLimit(request.query);

	const response = {
		voter_count: 0,
		'voters': []
	};
	let queryStruct: any = {
		"bool": {
			"must": []
		}
	};

	if (query.producer) {
		for (const bp of query.producer.split(",")) {
			queryStruct.bool.must.push({"term": {"producers": bp}});
		}
	}

	if (query.proxy === 'true') {
		queryStruct.bool.must.push({"term": {"is_proxy": true}});
	}

	if (queryStruct.bool.must.length === 0) {
		queryStruct = {
			"match_all": {}
		};
	}

	const maxDocs = fastify.manager.config.api.limits.get_voters ?? 100;
	const results = await fastify.elastic.search({
		"index": fastify.manager.chain + '-table-voters-*',
		"from": skip || 0,
		"size": (limit > maxDocs ? maxDocs : limit) || 10,
		"body": {
			"query": queryStruct,
			"sort": [{"last_vote_weight": "desc"}]
		}
	});
	const hits = results['body']['hits']['hits'];
	for (const hit of hits) {
		const voter = hit._source;
		response.voters.push({
			account: voter.voter,
			weight: voter.last_vote_weight,
			last_vote: voter.block_num
		});
	}
	response.voter_count = results['body']['hits']['total']['value'];
	return response;
}

export function getVotersHandler(fastify: FastifyInstance, route: string) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		reply.send(await timedQuery(getVoters, fastify, request, route));
	}
}
