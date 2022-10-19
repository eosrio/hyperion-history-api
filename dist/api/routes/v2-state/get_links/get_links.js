import { getTrackTotalHits, timedQuery } from "../../../helpers/functions.js";
import { getSkipLimit } from "../../v2-history/get_actions/functions.js";
async function getLinks(fastify, request) {
    const query = request.query;
    const { account, code, action, permissions } = query;
    const { skip, limit } = getSkipLimit(query);
    const queryStruct = {
        "bool": {
            must: [],
            must_not: []
        }
    };
    if (account) {
        queryStruct.bool.must.push({ 'term': { 'account': account } });
    }
    if (code) {
        queryStruct.bool.must.push({ 'term': { 'code': code } });
    }
    if (action) {
        queryStruct.bool.must.push({ 'term': { 'action': action } });
    }
    if (permissions) {
        queryStruct.bool.must.push({ 'term': { 'permissions': permissions } });
    }
    // only present deltas
    queryStruct.bool.must_not.push({ 'term': { 'present': 0 } });
    const maxLinks = fastify.manager.config.api.limits.get_links;
    // Prepare query
    const results = await fastify.elastic.search({
        index: fastify.manager.chain + '-link-*',
        from: skip || 0,
        size: (maxLinks && (limit > maxLinks) ? maxLinks : limit) || 50,
        track_total_hits: getTrackTotalHits(query),
        query: queryStruct,
        sort: 'block_num:desc'
    });
    const hits = results.hits.hits;
    const response = {
        cached: false,
        total: results.hits.total,
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
export function getLinksHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(getLinks, fastify, request, route));
    };
}
