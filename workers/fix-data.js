const {Api, Serialize} = require('eosjs');
const fetch = require('node-fetch')

const _ = require('lodash');
const {action_blacklist} = require('../definitions/blacklists');
const prettyjson = require('prettyjson');
const {AbiDefinitions} = require("../definitions/abi_def");
const {deserialize, unzipAsync} = require('../helpers/functions');

const async = require('async');
const {amqpConnect} = require("../connections/rabbitmq");
const {connectRpc} = require("../connections/chain");
const {elasticsearchConnect} = require("../connections/elasticsearch");

const {TextEncoder, TextDecoder} = require('util');

const redis = require('redis');
const {promisify} = require('util');
const rClient = redis.createClient({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
});
const getAsync = promisify(rClient.get).bind(rClient);

const txDec = new TextDecoder();
const txEnc = new TextEncoder();

let ch, api, types, client, cch, rpc, abi;
let tables = new Map();
let chainID = null;
let act_emit_idx = 1;
let delta_emit_idx = 1;
let block_emit_idx = 1;
let tbl_acc_emit_idx = 1;
let tbl_vote_emit_idx = 1;
let local_block_count = 0;
let allowStreaming = false;
let cachedMap;
let contracts = new Map();

const queue_prefix = process.env.CHAIN;
const queue = queue_prefix + ':blocks';
const index_queue_prefix = queue_prefix + ':index';
const index_queues = require('../definitions/index-queues').index_queues;
const n_deserializers = process.env.DESERIALIZERS;
const n_ingestors_per_queue = parseInt(process.env.ES_INDEXERS_PER_QUEUE, 10);
const action_indexing_ratio = parseInt(process.env.ES_ACT_QUEUES, 10);


async function getContractAtBlock(accountName, block_num) {
    if (contracts.has(accountName)) {
        let savedContract = contracts.get(accountName);
        const validUntil = savedContract['valid_until'];
        if (validUntil > block_num || validUntil === -1) {
            return [savedContract['contract'], null];
        }
    }
    const savedAbi = await getAbiAtBlock(accountName, block_num);
    const abi = savedAbi.abi;
    const initialTypes = Serialize.createInitialTypes();
    let types;
    try {
        types = Serialize.getTypesFromAbi(initialTypes, abi);
    } catch (e) {
        console.log(accountName, block_num);
        console.log(e);
    }
    const actions = new Map();
    for (const {name, type} of abi.actions) {
        actions.set(name, Serialize.getType(types, type));
    }
    const result = {types, actions};

    // 缓存contract
    contracts.set(accountName, {
        contract: result,
        valid_until: savedAbi.valid_until
    });
    return [result, abi];
}

function attachActionExtras(action) {
    // Transfer actions
    if (action['act']['name'] === 'transfer') {

        let qtd = null;
        if (action['act']['data']['quantity']) {
            qtd = action['act']['data']['quantity'].split(' ');
            delete action['act']['data']['quantity'];
        } else if (action['act']['data']['value']) {
            qtd = action['act']['data']['value'].split(' ');
            delete action['act']['data']['value'];
        }

        if (qtd) {
            action['@transfer'] = {
                from: String(action['act']['data']['from']),
                to: String(action['act']['data']['to']),
                amount: parseFloat(qtd[0]),
                symbol: qtd[1]
            };
            delete action['act']['data']['from'];
            delete action['act']['data']['to'];

            if (process.env.INDEX_TRANSFER_MEMO === 'true') {
                action['@transfer']['memo'] = action['act']['data']['memo'];
                delete action['act']['data']['memo'];
            }
        }

    } else if (action['act']['name'] === 'newaccount' && action['act']['account'] === 'eosio') {

        let name = null;
        if (action['act']['data']['newact']) {
            name = action['act']['data']['newact'];
        } else if (action['act']['data']['name']) {
            name = action['act']['data']['name'];
            delete action['act']['data']['name'];
        }
        if (name) {
            action['@newaccount'] = {
                active: action['act']['data']['active'],
                owner: action['act']['data']['owner'],
                newact: name
            }
        }
        // await handleNewAccount(action['act']['data'], action, ts);
    } else if (action['act']['name'] === 'updateauth' && action['act']['account'] === 'eosio') {
        // await handleUpdateAuth(action['act']['data'], action, ts);
        const _auth = action['act']['data']['auth'];
        if (_auth['accounts'].length === 0) delete _auth['accounts'];
        if (_auth['keys'].length === 0) delete _auth['keys'];
        if (_auth['waits'].length === 0) delete _auth['waits'];
        action['@updateauth'] = {
            permission: action['act']['data']['permission'],
            parent: action['act']['data']['parent'],
            auth: _auth
        };
    } else if (action['act']['name'] === 'unstaketorex' && action['act']['account'] === 'eosio') {
        let cpu_qtd = null;
        let net_qtd = null;
        if (action['act']['data']['from_net'] && action['act']['data']['from_cpu']) {
            cpu_qtd = parseFloat(action['act']['data']['from_cpu'].split(' ')[0]);
            net_qtd = parseFloat(action['act']['data']['from_net'].split(' ')[0]);
        }
        action['@unstaketorex'] = {
            amount: cpu_qtd + net_qtd,
            owner: action['act']['data']['owner'],
            receiver: action['act']['data']['receiver']
        };
    } else if (action['act']['name'] === 'buyrex' && action['act']['account'] === 'eosio') {
        let qtd = null;
        if (action['act']['data']['amount']) {
            qtd = parseFloat(action['act']['data']['amount'].split(' ')[0]);
        }
        action['@buyrex'] = {
            amount: qtd,
            from: action['act']['data']['from']
        };
    }
}

async function getAbiAtBlock(code, block_num) {
    const refs = cachedMap[code];
    if (refs) {
        if (refs.length > 0) {
            let lastblock = 0;
            let validity = -1;
            for (const block of refs) {
                if (block > block_num) {
                    validity = block;
                    break;
                } else {
                    lastblock = block;
                }
            }
            const cachedAbiAtBlock = await getAsync(process.env.CHAIN + ":" + lastblock + ":" + code);
            let abi;
            if (!cachedAbiAtBlock) {
                console.log('remote abi fetch [1]', code, block_num);
                abi = await api.getAbi(code);
            } else {
                abi = JSON.parse(cachedAbiAtBlock);
            }
            return {
                abi: abi,
                valid_until: validity
            }
        } else {
            console.log('remote abi fetch [2]', code, block_num);
            return {
                abi: await api.getAbi(code),
                valid_until: null
            };
        }
    } else {
        const ref_time = Date.now();
        const _abi = await api.getAbi(code);
        const elapsed_time = (Date.now() - ref_time);
        if (elapsed_time > 10) {
            console.log('remote abi fetch [3]', code, block_num, elapsed_time);
        }
        return {
            abi: _abi,
            valid_until: null
        };
    }
}


async function getData (block_num) {
    let results
    results = await client.search({
        index: process.env.CHAIN + '-action-*',
        size: 1000,
        body: {
            "query": {
                "match" : {
                    "block_num" : block_num
                }
            }    
        }
    })
    return results.hits.hits
}

let retry = 0

async function deserializeErrorAction (action, fix_num) {
    // console.log(action)
    let {account, name, authorization, data} =  action._source.act
    let original_act = Object.assign({}, action._source)
    if (typeof data === "string" && data !== "") {
        dataBuffer  = new Buffer.from(data, 'hex')
        data = new Uint8Array(dataBuffer)
        try {
            const contract = (await getContractAtBlock(account, action._id))[0];
            // console.log('contract: ', contract)
            let ds_action = Serialize.deserializeAction(
            contract, account, name, authorization, data, txEnc, txDec);
            original_act.act = ds_action
            attachActionExtras(original_act)
            // console.log("重新解析的",ds_action)
            let resp = await client.index({
                index: queue_prefix + '-action',
                id: action._id,
                type: '_doc',
                body: {
                    ...original_act
                }
            })

            retry = 0 // clear retry flag
        } catch (e) {
            console.error('fix_num:', fix_num)
            console.error('fix error: ', e)
            if (retry < 5) {
                retry++ 
                console.log(`retry ${action._source.trx_id} ${retry} times`)
                await deserializeErrorAction (action, fix_num)
            } else {
                retry = 0
                let fix_error = await getAsync('fix_error')
                if (fix_error === 'false') {
                    let alert_time = await getAsync('alert_num')
                    if (alert_time <= 5) {
                        rClient.set('alert_num', alert_time+1)
                        fetch('http://monitor.enjoyshare.net/alarm_upload', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                "type": 4,  
                                "code": "86fcad64-5e8d-4b08-84af-c33f61faa428",  
                                "node": "", 
                                "extra": `deserialize action ${action._id} data failed`
                            })
                        })
                    }
                    rClient.set('fix_num', fix_num)
                    rClient.set('fix_error', 'true')
                    
                }
            }
        }
    }
}



(async () => {
    rClient.set('fix_num', 0)
    rClient.set('fix_error', 'false')
    rClient.set('alert_num', 0)
    cachedMap = JSON.parse(await getAsync(process.env.CHAIN + ":" + 'abi_cache'));
    rpc = connectRpc();
    let chain_data = await rpc.get_info();
    chainID = chain_data.chain_id;
    api = new Api({
        "rpc": rpc,
        signatureProvider: null,
        chainId: chain_data.chain_id,
        textDecoder: txDec,
        textEncoder: txEnc,
    });

    client = elasticsearchConnect();

    // Connect to RabbitMQ (amqplib)
    [ch, cch] = await amqpConnect();

    // fix data
    while (1) {
        console.log('start to fix data at ', Date.now())
        chain_data = await rpc.get_info();
        head_block_num = chain_data.head_block_num
        let data = []
        rClient.set('fix_error', 'false') // 重置标记
        let fix_num = await getAsync('fix_num')
        while(fix_num < head_block_num) {
            data = await getData(fix_num)
            // console.log(data.length)
            
            if (Array.isArray(data)) {
                data.forEach(async action => {
                    await deserializeErrorAction(action, fix_num)
                })
            }
            fix_num++
            // console.log(fix_num)
        } 
        let fix_error = await getAsync('fix_error')
        if (fix_error === 'false') {
            rClient.set('fix_num', fix_num)
        }
        // set space of time
        await new Promise((resolve,reject) => {
            setTimeout(() => {
                resolve()
            }, 10000)
        })
    }
})()