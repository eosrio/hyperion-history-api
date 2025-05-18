import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {API} from "@wharfkit/antelope";

async function getCreator(fastify: FastifyInstance, request: FastifyRequest) {

    const query: any = request.query;

    const response = {
        account: query.account,
        creator: '',
        timestamp: '',
        block_num: 0,
        trx_id: '',
    };

    if (query.account === fastify.manager.config.settings.eosio_alias) {
        try {
            const genesisBlock = await fastify.antelope.chain.get_block(1);
            if (genesisBlock) {
                response.timestamp = genesisBlock.timestamp.toString();
            }
        } catch (e: any) {
            console.log(e.message);
        }
        response.creator = '__self__';
        response.block_num = 1;
        response.trx_id = "";
        return response;
    }

    const results = await fastify.elastic.search<any>({
        index: fastify.manager.chain + '-action-*',
        size: 1,
        query: {
            bool: {
                must: [{term: {"@newaccount.newact": query.account}}]
            }
        }
    });

    if (results.hits.hits.length === 1) {
        const result = results.hits.hits[0]._source;
        response.trx_id = result.trx_id;
        response.block_num = result.block_num;
        response.creator = result.act.data.creator;
        response.timestamp = result['@timestamp'];
        return response;
    } else {
        let accountInfo: API.v1.AccountObject;
        try {
            accountInfo = await fastify.antelope.getAccountUntyped(query.account);
            console.log(accountInfo);
        } catch (e) {
            throw new Error("account not found");
        }
        if (accountInfo && accountInfo.created) {
            try {
                response.timestamp = accountInfo.created.toString();
                const blockHeader = await fastify.elastic.search<any>({
                    index: fastify.manager.chain + '-block-*',
                    size: 1,
                    query: {
                        bool: {
                            must: [{term: {"@timestamp": response.timestamp}}]
                        }
                    }
                });
                const hits = blockHeader.hits.hits;
                console.log('hits', hits);
                if (hits.length > 0 && hits[0]._source) {
                    const blockId = blockHeader.hits.hits[0]._source.block_id;
                    const blockData = await fastify.antelope.chain.get_block(blockId);
                    response.block_num = blockData.block_num.toNumber();
                    for (const transaction of blockData.transactions) {
                        const actions = transaction.trx.transaction?.actions;
                        if (!actions) {
                            continue;
                        }
                        for (const act of actions) {
                            if (act.name.equals('newaccount')) {
                                // console.log(act);
                                // TODO: test this
                                // @ts-ignore
                                if (act.data.name === query.account) {
                                    // @ts-ignore
                                    response.creator = act.data.creator;
                                    response.trx_id = transaction.id.toString();
                                    return response;
                                }
                            }
                        }

                    }
                }
                return response;
            } catch (e: any) {
                console.log(e.message);
                throw new Error("account creation not found");
            }
        } else {
            throw new Error("account not found");
        }
    }
}

export function getCreatorHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getCreator, fastify, request, route));
    }
}
