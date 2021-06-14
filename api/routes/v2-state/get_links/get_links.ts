import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {getTrackTotalHits, timedQuery} from "../../../helpers/functions";
import {ApiResponse} from "@elastic/elasticsearch";
import {getSkipLimit} from "../../v2-history/get_actions/functions";

async function getLinks(fastify: FastifyInstance, request: FastifyRequest) {
	const query: any = request.query;
	const {account, code, action, permissions} = query;
	const {skip, limit} = getSkipLimit(query);

	const queryStruct = {
		"bool": {
			must: [],
			must_not: []
		}
	};

	if (account) {
		queryStruct.bool.must.push({'term': {'account': account}});
	}

	if (code) {
		queryStruct.bool.must.push({'term': {'code': code}});
	}

	if (action) {
		queryStruct.bool.must.push({'term': {'action': action}});
	}

	if (permissions) {
		queryStruct.bool.must.push({'term': {'permissions': permissions}});
	}

	// only present deltas
	queryStruct.bool.must_not.push({'term': {'present': 0}});

	// Prepare query body
	const query_body = {
		track_total_hits: getTrackTotalHits(query),
		query: queryStruct,
		sort: {block_num: 'desc'}
	};

	const maxLinks = fastify.manager.config.api.limits.get_links;
	const results: ApiResponse = await fastify.elastic.search({
		index: fastify.manager.chain + '-link-*',
		from: skip || 0,
		size: (limit > maxLinks ? maxLinks : limit) || 50,
		body: query_body
	});
	const hits = results.body.hits.hits;
	const response: any = {
		cached: false,
		total: results.body.hits.total,
		links: []
	};

	for (const hit of hits) {
		const link = hit._source;
		link.timestamp = link['@timestamp'];
		delete link['@timestamp'];
		response.links.push(link);
	}
	return response;
}

export function getLinksHandler(fastify: FastifyInstance, route: string) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		reply.send(await timedQuery(getLinks, fastify, request, route));
	}
}
