import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions";

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
        const genesisBlock = await fastify.eosjs.rpc.get_block(1);
        if (genesisBlock) {
            response.creator = '__self__';
            response.timestamp = genesisBlock.timestamp;
            response.block_num = 1;
            response.trx_id = "";
            return response;
        } else {
            throw new Error("genesis block not found");
        }
    }

    const results = await fastify.elastic.search({
        "index": fastify.manager.chain + '-action-*',
        "body": {
            size: 1,
            query: {
                bool: {
                    must: [{term: {"@newaccount.newact": query.account}}]
                }
            }
        }
    });

    if (results['body']['hits']['hits'].length === 1) {
        const result = results['body']['hits']['hits'][0]._source;
        response.trx_id = result.trx_id;
        response.block_num = result.block_num;
        response.creator = result.act.data.creator;
        response.timestamp = result['@timestamp'];
        return response;
    } else {
        let accountInfo;
        try {
            accountInfo = await fastify.eosjs.rpc.get_account(query.account);
        } catch (e) {
            throw new Error("account not found");
        }
        if (accountInfo) {
            try {
                response.timestamp = accountInfo.created;
                const blockHeader = await fastify.elastic.search({
                    "index": fastify.manager.chain + '-block-*',
                    "body": {
                        size: 1,
                        query: {
                            bool: {
                                must: [{term: {"@timestamp": response.timestamp}}]
                            }
                        }
                    }
                });
                const hits = blockHeader['body']['hits']['hits'];
                if (hits.length > 0 && hits[0]._source) {
                    const blockId = blockHeader['body']['hits']['hits'][0]._source.block_id;
                    const blockData = await fastify.eosjs.rpc.get_block(blockId);
                    response.block_num = blockData.block_num;
                    for (const transaction of blockData["transactions"]) {
                        if (typeof transaction.trx !== 'string') {
                            const actions = transaction.trx.transaction.actions;
                            for (const act of actions) {
                                if (act.name === 'newaccount') {
                                    if (act.data.name === query.account) {
                                        response.creator = act.data.creator;
                                        response.trx_id = transaction.id;
                                        return response;
                                    }
                                }
                            }
                        }
                    }
                }
                return response;
            } catch (e) {
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
