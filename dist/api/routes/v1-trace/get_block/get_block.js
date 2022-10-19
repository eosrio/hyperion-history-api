import { timedQuery } from "../../../helpers/functions.js";
import { group } from "radash";
async function getBlockTrace(fastify, request) {
    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body);
    }
    const reqBody = request.body;
    const targetBlock = parseInt(reqBody.block_num);
    let searchBody;
    if (reqBody.block_id) {
        searchBody = {
            query: {
                bool: {
                    must: [
                        { term: { block_id: reqBody.block_id } }
                    ]
                }
            }
        };
    }
    else {
        if (targetBlock > 0) {
            searchBody = {
                query: {
                    bool: {
                        must: [
                            { term: { block_num: targetBlock } }
                        ]
                    }
                }
            };
        }
        else if (targetBlock < 0) {
            searchBody = {
                query: { match_all: {} },
                sort: { block_num: "desc" }
            };
        }
    }
    const response = { transactions: [] };
    if (searchBody) {
        const getBlockHeader = await fastify.elastic.search({
            index: fastify.manager.chain + "-block-*",
            size: 1,
            body: searchBody
        });
        if (getBlockHeader.hits.hits.length === 1) {
            const block = getBlockHeader.hits.hits[0]._source;
            const info = await fastify.eosjs.rpc.get_info();
            response.id = block.block_id;
            response.number = block.block_num;
            response.previous_id = block.prev_id;
            response.status = info.last_irreversible_block_num > block.block_num ? "irreversible" : "pending";
            response.timestamp = block['@timestamp'];
            response.producer = block.producer;
            // lookup all actions on block
            const getActionsResponse = await fastify.elastic.search({
                index: fastify.manager.chain + "-action-*",
                size: fastify.manager.config.api.limits.get_actions || 1000,
                query: {
                    bool: {
                        must: [
                            { term: { block_num: block.block_num } }
                        ]
                    }
                },
                sort: ["global_sequence:asc"]
            });
            const hits = getActionsResponse.hits.hits;
            if (hits.length > 0) {
                const trxGroup = group(hits, (v) => v._source?.trx_id ?? ".");
                for (let trxId in trxGroup) {
                    const actArray = [];
                    for (const act of trxGroup[trxId]) {
                        const action = act['_source'];
                        if (action) {
                            for (const receipt of action.receipts) {
                                actArray.push({
                                    receiver: receipt.receiver,
                                    account: action.act.account,
                                    action: action.act.name,
                                    authorization: action.act.authorization.map(auth => {
                                        return { account: auth.actor, permission: auth.permission };
                                    }),
                                    data: action.act.data
                                });
                            }
                        }
                    }
                    response.transactions.push({ id: trxId, actions: actArray });
                }
            }
            return response;
        }
        else {
            throw new Error('block not found!');
        }
    }
    else {
        throw new Error("invalid block number or id");
    }
}
export function getBlockTraceHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(getBlockTrace, fastify, request, route));
    };
}
