import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getTrackTotalHits, timedQuery } from "../../../helpers/functions.js";
import { estypes } from '@elastic/elasticsearch';

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

    const maxDocs = fastify.manager.config.api.limits.get_proposals ?? 100;

    const response: any = {
        query_time_ms: 0,
        cached: false,
        total: 0,
        proposals: [],
        last_indexed_block: 0,
        last_indexed_block_time: ''
    };

    let stateResult: any[];
    const startTime = Date.now(); // Inicia o cronômetro para a consulta

    // Verifica se a consulta deve ser feita no MongoDB
    if (fastify.manager.config.indexer.experimental_mongodb_state && fastify.manager.conn.mongodb && query.useMongo === 'true') {
        const dbName = `${fastify.manager.conn.mongodb.database_prefix}_${fastify.manager.chain}`;
        const collection = fastify.mongo.client.db(dbName).collection('proposals');

        const mongoQuery: any = {};
        if (query.account) {
            const accounts = query.account.split(',');
            mongoQuery.$or = [
                { "requested_approvals.actor": { $in: accounts } },
                { "provided_approvals.actor": { $in: accounts } }
            ];
        }
        if (query.proposer) {
            mongoQuery.proposer = query.proposer;
        }
        if (query.proposal) {
            mongoQuery.proposal_name = query.proposal;
        }
        if (typeof query.executed !== 'undefined') {
            mongoQuery.executed = query.executed;
        }
        if (query.requested) {
            mongoQuery["requested_approvals.actor"] = query.requested;
        }
        if (query.provided) {
            mongoQuery["provided_approvals.actor"] = query.provided;
        }

        // Consultar MongoDB
        console.log(`Consultar Mongo`)
        const lastBlockResult = await fastify.mongo.client.db(dbName).collection('proposals').find().sort({ block_num: -1 }).limit(1).toArray();
        response.last_indexed_block = lastBlockResult[0]?.block_num || 0;
        response.last_indexed_block_time = lastBlockResult[0]?.block_time || '';

        response.total = await collection.countDocuments(mongoQuery);
        stateResult = await collection
            .find(mongoQuery)
            .skip(skip || 0)
            .limit(limit || 50)
            .toArray();

    } else {
        // Caso não seja no MongoDB, faz a consulta no Elasticsearch
        console.log(`Consultar Elastic`)
        let queryStruct: any = { bool: { must: [] } };
        if (query.account) {
            const accounts = query.account.split(',');
            for (const acc of accounts) {
                queryStruct.bool.must.push({
                    bool: {
                        should: [
                            { term: { "requested_approvals.actor": acc } },
                            { term: { "provided_approvals.actor": acc } }
                        ]
                    }
                });
            }
        }
        if (query.proposer) {
            queryStruct.bool.must.push({ term: { proposer: query.proposer } });
        }
        if (query.proposal) {
            queryStruct.bool.must.push({ term: { proposal_name: query.proposal } });
        }
        if (typeof query.executed !== 'undefined') {
            queryStruct.bool.must.push({ term: { executed: query.executed } });
        }
        if (query.requested) {
            queryStruct.bool.must.push({ term: { "requested_approvals.actor": query.requested } });
        }
        if (query.provided) {
            queryStruct.bool.must.push({ term: { "provided_approvals.actor": query.provided } });
        }

        if (queryStruct.bool.must.length === 0) {
            queryStruct = { match_all: {} };
        }

        // Consultar Elasticsearch
        const esResult = await fastify.elastic.search<any>({
            index: `${fastify.manager.chain}-table-proposals-*`,
            from: skip || 0,
            size: (limit > maxDocs ? maxDocs : limit) || 10,
            track_total_hits: getTrackTotalHits(request.query),
            query: queryStruct,
            sort: [{ block_num: "desc" }]
        });

        stateResult = esResult.hits.hits.map((hit: any) => hit._source);
        response.total = (esResult.hits.total as estypes.SearchTotalHits).value;

        // Pegando o último bloco indexado
        response.last_indexed_block = esResult.hits.hits.length > 0 ? esResult.hits.hits[0]._source.block_num : 0;
        response.last_indexed_block_time = esResult.hits.hits.length > 0 ? esResult.hits.hits[0]._source.block_time : '';
    }

    // Formatar resposta com os dados obtidos
    for (const proposal of stateResult) {
        response.proposals.push(proposal);
    }

    // Calculando o tempo de consulta
    response.query_time_ms = Date.now() - startTime;

    return response;
}

export function getProposalsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getProposals, fastify, request, route));
    };
}
