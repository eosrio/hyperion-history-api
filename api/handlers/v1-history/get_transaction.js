const {getTransactionV1Schema} = require("../../schemas");
const _ = require('lodash');
const {getCacheByHash, mergeActionMeta} = require("../../helpers/functions");
const crypto = require('crypto');


const schema = {
    description: 'get all actions belonging to the same transaction',
    summary: 'get transaction by id',
    tags: ['history'],
    body: {
        type: ['object', 'string'],
        properties: {
            "id": {
                description: 'transaction id',
                type: 'string'
            }
        },
        required: ["id"]
    }
};

async function getTransaction(fastify, request) {
    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body)
    }
    const {redis, elastic, eosjs} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.body));
    if (cachedResponse) {
        return cachedResponse;
    }
    const pResults = await Promise.all([eosjs.rpc.get_info(), elastic['search']({
        "index": process.env.CHAIN + '-action-*',
        "body": {
            "query": {
                "bool": {
                    must: [
                        {term: {"trx_id": request.body.id.toLowerCase()}}
                    ]
                }
            },
            "sort": {
                "global_sequence": "asc"
            }
        }
    })]);
    const results = pResults[1];
    const response = {
        "id": request.body.id,
        "trx": {
            "receipt": {
                "status": "executed",
                "cpu_usage_us": 0,
                "net_usage_words": 0,
                "trx": [1, {
                    "signatures": "",
                    "compression": "none",
                    "packed_context_free_data": "",
                    "packed_trx": ""
                }]
            },
            "trx": {}
        },
        "block_num": 0,
        "block_time": "",
        "last_irreversible_block": pResults[0].last_irreversible_block_num,
        "traces": []
    };

    const hits = results['body']['hits']['hits'];

    if (hits.length > 0) {
        const actions = hits;
        response.trx.trx = {
            "expiration": "",
            "ref_block_num": 0,
            "ref_block_prefix": 0,
            "max_net_usage_words": 0,
            "max_cpu_usage_ms": 0,
            "delay_sec": 0,
            "context_free_actions": [],
            "actions": [],
            "transaction_extensions": [],
            "signatures": [],
            "context_free_data": []
        };
        let traces = {};
        let seqNum = 0;
        for (let action of actions) {
            action = action._source;
            mergeActionMeta(action);
            action.act['hex_data'] = new Buffer.from(JSON.stringify(action.act.data)).toString('hex');
            if (action.parent === 0) {
                response.trx.trx.actions.push(action.act);
            }
            response.block_num = action.block_num;
            response.block_time = action['@timestamp'];
            seqNum += 1;
            let trace = {
                receipt: {
                    receiver: action.act.account,
                    global_sequence: String(action.global_sequence),
                    auth_sequence: [
                        action.act.authorization[0].actor,
                        seqNum
                    ],
                    act_digest: '',
                    recv_sequence: seqNum,
                    code_sequence: 1,
                    abi_sequence: 1
                },
                act: action.act,
                account_ram_deltas: action.account_ram_deltas || [],
                context_free: false,
                block_num: action.block_num,
                block_time: action['@timestamp'],
                console: "",
                elapsed: 0,
                except: null,
                inline_traces: [],
                producer_block_id: "",
                trx_id: request.body.id,
                notified: action.notified
            };
            let hash = crypto.createHash('sha256');
            hash.update(JSON.stringify(action.act));
            trace.receipt.act_digest = hash.digest('hex');
            traces[action.global_sequence] = trace;
        }

        actions.forEach(action => {
            action = action._source;
            for (let i = 0; i < traces[action.global_sequence].notified.length; i++) {
                if (traces[action.global_sequence].notified[i] === action.act.account) {
                    traces[action.global_sequence].notified.splice(i, 1);
                    break;
                }
            }
            if (action.parent !== 0 && action.parent) {
                if (traces[action.parent]) {
                    for (let i = 0; i < traces[action.parent].notified.length; i++) {
                        if (traces[action.parent].notified[i] === action.act.account) {
                            traces[action.parent].notified.splice(i, 1);
                            break;
                        }
                    }
                    traces[action.parent].inline_traces.push(traces[action.global_sequence]);
                }
            }
        });

        actions.forEach(action => {
            action = action._source;
            response.traces.push(traces[action.global_sequence]);
            traces[action.global_sequence].notified.forEach((note, index) => {
                seqNum += 1;
                let trace = {
                    receipt: {
                        receiver: note,
                        global_sequence: String(action.global_sequence + index + 1),
                        auth_sequence: [
                            action.act.authorization[0].actor,
                            seqNum
                        ],
                        act_digest: traces[action.global_sequence].receipt.act_digest,
                        recv_sequence: seqNum,
                        code_sequence: 1,
                        abi_sequence: 1
                    },
                    account_ram_deltas: action.account_ram_deltas || [],
                    act: action.act,
                    block_num: action.block_num,
                    block_time: action['@timestamp'],
                    console: "",
                    context_free: false,
                    elapsed: 0,
                    except: null,
                    inline_traces: [],
                    producer_block_id: "",
                    trx_id: request.body.id,
                };
                traces[action.global_sequence].inline_traces.unshift(trace);
                response.traces.push(trace);
            });
            delete traces[action.global_sequence].notified;
        });
        redis.set(hash, JSON.stringify(response), 'EX', 30);
    } else {
        return {
            code: 500,
            message: "Internal Service Error",
            error: {
                code: 3040011,
                name: "tx_not_found",
                what: "The transaction can not be found",
                details: [
                    {
                        "message": "Transaction " + request.body.id.toLowerCase() + " not found in history and no block hint was given",
                        "file": "",
                        "line_number": 1,
                        "method": "get_transaction"
                    }
                ]
            }
        }
    }

    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.post('/get_transaction', {schema}, async (request, reply) => {
        reply.send(await getTransaction(fastify, request));
    });
    next()
};
