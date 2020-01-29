const {Serialize} = require('../eosjs-native');

const abieos = require('../addons/node-abieos/abieos.node');

const simdjson = require('simdjson');

const {Api} = require('eosjs');

const {AbiDefinitions, RexAbi} = require("../definitions/abi_def");
const async = require('async');
const {debugLog} = require("../helpers/functions");
const {promisify} = require('util');
const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

const config = require(`../${process.env.CONFIG_JSON}`);
let EOSIO_ALIAS = 'eosio';
if (config.settings['eosio_alias']) {
    EOSIO_ALIAS = config.settings['eosio_alias'];
}

const rClient = manager.redisClient;
const getAsync = promisify(rClient.get).bind(rClient);

const txDec = new TextDecoder();
const txEnc = new TextEncoder();

let ch, api, types, client, cch, rpc, abi;
let ch_ready = false;
let tables = new Map();
let chainID = null;
let act_emit_idx = 1;
let delta_emit_idx = 1;
let block_emit_idx = 1;

let tbl_acc_emit_idx = 1;
let tbl_vote_emit_idx = 1;
let tbl_prop_emit_idx = 1;

let local_block_count = 0;
let allowStreaming = false;
let cachedMap;

let contracts = new Map();
let contractHitMap = new Map();

const queue_prefix = config.settings.chain;
const queue = queue_prefix + ':blocks';
const index_queue_prefix = queue_prefix + ':index';
const index_queues = require('../definitions/index-queues').index_queues;
const n_deserializers = config['scaling']['ds_queues'];
const n_ingestors_per_queue = config['scaling']['indexing_queues'];
const action_indexing_ratio = config['scaling']['ad_idx_queues'];

// Stage 2 consumer prefetch
const deserializerPrefetch = config.prefetch.block;
const consumerQueue = async.cargo(async.ensureAsync(processPayload), deserializerPrefetch);

const preIndexingQueue = async.queue(async.ensureAsync(sendToIndexQueue), 1);

// Load Modules
const HyperionModuleLoader = require('../modules/index').HyperionModuleLoader;
const mLoader = new HyperionModuleLoader(config.settings.parser);

const common = {
    attachActionExtras,
    processBlock,
    deserializeActionAtBlockNative,
    deserializeNative
};

function deserializeNative(datatype, array, use_simdjson) {
    let result;
    if (typeof array === 'string') {
        result = abieos['hex_to_json']("0", datatype, array);
    } else {
        result = abieos['bin_to_json']("0", datatype, array);
    }
    if (result !== 'PARSING_ERROR') {
        try {
            if (use_simdjson) {
                return simdjson['lazyParse'](result);
            } else {
                return JSON.parse(result);
            }
        } catch (e) {
            console.log(datatype, e);
            return null;
        }
    } else {
        console.log(result, datatype);
        return null;
    }
}

function sendToIndexQueue(data, cb) {
    if (ch_ready) {
        ch.sendToQueue(data.queue, data.content);
        cb();
    } else {
        console.log('Channel is not ready!');
    }
}

// Stage 2 - Deserialization handler
function processPayload(payload, cb) {
    processMessages(payload).then(() => {
        cb();
    }).catch((err) => {
        console.log('NACK ALL', err);
        if (ch_ready) {
            ch.nackAll();
        }
    })
}

// Stage 2 - Deserialization function
async function processMessages(messages) {
    await mLoader.messageParser(common, messages, types, ch, ch_ready);
}

// let tempDSCount = BigInt(0);
// let totalDSTime = BigInt(0);
// setInterval(() => {
//     if (tempDSCount > 1000) {
//         const avg_ds_time = totalDSTime / tempDSCount;
//         console.log(`AVG DS Time: ${avg_ds_time} ns | Speed: ${BigInt(1000000000) / avg_ds_time} actions/s`);
//     }
//     if (tempDSCount > 100000) {
//         tempDSCount = BigInt(0);
//         totalDSTime = BigInt(0);
//     }
// }, 1000);

function pushToBlocksQueue(light_block) {
    if (!config.indexer['disable_indexing']) {
        const data = Buffer.from(JSON.stringify(light_block));
        const q = index_queue_prefix + "_blocks:" + (block_emit_idx);
        preIndexingQueue.push({
            queue: q,
            content: data
        });
        block_emit_idx++;
        if (block_emit_idx > n_ingestors_per_queue) {
            block_emit_idx = 1;
        }
    }
    local_block_count++;
}

function pushToActionsQueue(payload) {
    if (!config.indexer['disable_indexing']) {
        const q = index_queue_prefix + "_actions:" + (act_emit_idx);
        preIndexingQueue.push({
            queue: q,
            content: payload
        });
        act_emit_idx++;
        if (act_emit_idx > (n_ingestors_per_queue * action_indexing_ratio)) {
            act_emit_idx = 1;
        }
    }
}

function pushToActionStreamingQueue(payload, uniqueAction) {
    if (allowStreaming && config.features['streaming'].traces) {
        const notifArray = new Set();
        uniqueAction.act.authorization.forEach(auth => {
            notifArray.add(auth.actor);
        });
        uniqueAction.notified.forEach(acc => {
            notifArray.add(acc);
        });
        const headers = {
            event: 'trace',
            account: uniqueAction['act']['account'],
            name: uniqueAction['act']['name'],
            notified: [...notifArray].join(",")
        };
        ch.publish('', queue_prefix + ':stream', payload, {headers});
    }
}

function pushToDeltaQueue(bufferdata) {
    const q = index_queue_prefix + "_deltas:" + (delta_emit_idx);
    preIndexingQueue.push({
        queue: q,
        content: bufferdata
    });
    delta_emit_idx++;
    if (delta_emit_idx > (n_ingestors_per_queue * action_indexing_ratio)) {
        delta_emit_idx = 1;
    }
}

function pushToDeltaStreamingQueue(payload, jsonRow) {
    if (allowStreaming && config.features['streaming']['deltas']) {
        ch.publish('', queue_prefix + ':stream', payload, {
            headers: {
                event: 'delta',
                code: jsonRow.code,
                table: jsonRow.table,
                scope: jsonRow.scope,
                payer: jsonRow.payer
            }
        });
    }
}

let temp_ds_counter = 0;
let temp_delta_counter = 0;

// Stage 2 - Block handler
async function processBlock(res, block, traces, deltas) {
    if (!res['this_block']) {
        // missing current block data
        console.log(res);
        return null;
    } else {

        let producer = '';
        let ts = '';
        const block_num = res['this_block']['block_num'];
        const block_ts = res['this_time'];

        let light_block;

        if (config.indexer.fetch_block) {
            if (!block) {
                console.log(res);
            }
            producer = block['producer'];
            ts = block['timestamp'];

            // Collect total CPU and NET usage
            let total_cpu = 0;
            let total_net = 0;
            block.transactions.forEach((trx) => {
                total_cpu += trx['cpu_usage_us'];
                total_net += trx['net_usage_words'];
            });

            // const cpu_pct = ((total_cpu / 200000) * 100).toFixed(2);
            // const net_pct = ((total_net / 1048576) * 100).toFixed(2);
            // console.log(`Block: ${res['this_block']['block_num']} | CPU: ${total_cpu} μs (${cpu_pct} %) | NET: ${total_net} bytes (${net_pct} %)`);

            light_block = {
                '@timestamp': block['timestamp'],
                block_num: res['this_block']['block_num'],
                producer: block['producer'],
                new_producers: block['new_producers'],
                schedule_version: block['schedule_version'],
                cpu_usage: total_cpu,
                net_usage: total_net
            };

            if (light_block.new_producers) {
                process.send({
                    event: 'new_schedule',
                    block_num: light_block.block_num,
                    new_producers: light_block.new_producers,
                    live: process.env.live_mode
                });
            }
        }

        // Process Delta Traces
        if (deltas && config.indexer['process_deltas']) {
            const t1 = Date.now();
            await processDeltas(deltas, block_num, block_ts);
            const elapsed_time = Date.now() - t1;
            if (elapsed_time > 1000) {
                console.log(`[WARNING] Delta processing took ${elapsed_time} ms on block ${block_num}`);
            }
        }

        // Process Action Traces
        let _traces = traces;
        if (traces["valueForKeyPath"]) {
            _traces = traces['valueForKeyPath'](".");
        }
        if (_traces.length > 0 && config.indexer.fetch_traces) {
            const t2 = Date.now();
            for (const trace of _traces) {
                const transaction_trace = trace[1];
                const {cpu_usage_us, net_usage_words} = transaction_trace;
                if (transaction_trace.status === 0) {
                    let action_count = 0;
                    const trx_id = transaction_trace['id'].toLowerCase();
                    const _actDataArray = [];
                    const _processedTraces = [];
                    const action_traces = transaction_trace['action_traces'];
                    const t3 = Date.now();

                    // if (action_traces.length < 50) {
                    // console.log(action_traces.length);

                    for (const action_trace of action_traces) {
                        if (action_trace[0] === 'action_trace_v0') {
                            const action = action_trace[1];
                            const trx_data = {trx_id, block_num, producer, cpu_usage_us, net_usage_words};

                            // const start = process.hrtime.bigint();
                            const ds_status = await mLoader.actionParser(common, ts, action, trx_data, _actDataArray, _processedTraces, transaction_trace);

                            if (ds_status) {
                                temp_ds_counter++;
                                action_count++;
                            }

                            // const end = process.hrtime.bigint();
                            // totalDSTime += (end - start);
                            // tempDSCount++;
                        }
                    }

                    // }

                    const _finalTraces = [];
                    if (_processedTraces.length > 1) {
                        const act_digests = {};

                        // collect digests & receipts
                        for (const _trace of _processedTraces) {
                            if (act_digests[_trace.receipt.act_digest]) {
                                act_digests[_trace.receipt.act_digest].push(_trace.receipt);
                            } else {
                                act_digests[_trace.receipt.act_digest] = [_trace.receipt];
                            }
                        }

                        // Apply notified accounts to first trace instance
                        for (const _trace of _processedTraces) {
                            if (act_digests[_trace.receipt.act_digest]) {
                                const notifiedSet = new Set();
                                _trace['receipts'] = [];
                                for (const _receipt of act_digests[_trace.receipt.act_digest]) {
                                    notifiedSet.add(_receipt.receiver);
                                    _trace['code_sequence'] = _receipt['code_sequence'];
                                    delete _receipt['code_sequence'];
                                    _trace['abi_sequence'] = _receipt['abi_sequence'];
                                    delete _receipt['abi_sequence'];
                                    delete _receipt['act_digest'];
                                    _trace['receipts'].push(_receipt);
                                }
                                _trace['notified'] = [...notifiedSet];
                                delete act_digests[_trace.receipt.act_digest];
                                delete _trace['receipt'];
                                delete _trace['receiver'];
                                _finalTraces.push(_trace);
                            }
                        }

                    } else if (_processedTraces.length === 1) {
                        // single action on trx
                        const _trace = _processedTraces[0];
                        _trace['code_sequence'] = _trace['receipt'].code_sequence;
                        _trace['abi_sequence'] = _trace['receipt'].abi_sequence;
                        _trace['act_digest'] = _trace['receipt'].act_digest;
                        _trace['notified'] = [_trace['receipt'].receiver];
                        delete _trace['receipt']['code_sequence'];
                        delete _trace['receipt']['abi_sequence'];
                        delete _trace['receipt']['act_digest'];
                        _trace['receipts'] = [_trace['receipt']];
                        delete _trace['receipt'];
                        _finalTraces.push(_trace);
                    }

                    // Submit Actions after deduplication
                    // console.log(_finalTraces.length);
                    for (const uniqueAction of _finalTraces) {

                        const payload = Buffer.from(JSON.stringify(uniqueAction));

                        pushToActionsQueue(payload);

                        pushToActionStreamingQueue(payload, uniqueAction);
                    }

                    const act_elapsed_time = Date.now() - t3;
                    if (act_elapsed_time > 100) {
                        debugLog(`[WARNING] Actions processing took ${act_elapsed_time}ms on trx ${trx_id}`);
                        // console.log(action_traces);
                    }
                }
            }
            const traces_elapsed_time = Date.now() - t2;
            if (traces_elapsed_time > 10) {
                debugLog(`[WARNING] Traces processing took ${traces_elapsed_time}ms on block ${block_num}`);
            }
        }

        // Send light block to indexer
        if (config.indexer.fetch_block) {
            pushToBlocksQueue(light_block);
        }

        return {block_num: res['this_block']['block_num'], size: traces.length};
    }
}

function hitContract(code, block_num) {
    if (contractHitMap.has(code)) {
        contractHitMap.get(code).hits += 1;
        contractHitMap.get(code).last_usage = block_num;
    } else {
        contractHitMap.set(code, {
            hits: 1,
            last_usage: block_num
        });
    }
}

const abi_remapping = {
    "_Bool": "bool"
};

async function getContractAtBlock(accountName, block_num, check_action) {

    if (contracts.has(accountName)) {
        let _sc = contracts.get(accountName);
        hitContract(accountName, block_num);
        if ((_sc['valid_until'] > block_num && block_num > _sc['valid_from']) || _sc['valid_until'] === -1) {
            if (_sc['contract'].actions.has(check_action)) {
                console.log('cached abi');
                return [_sc['contract'], null];
            }
        }
    }

    let savedAbi, abi;
    savedAbi = await fetchAbiHexAtBlockElastic(accountName, block_num, true);

    if (savedAbi === null || !savedAbi.actions.includes(check_action)) {
        // console.log(`no ABI indexed for ${accountName}`);
        savedAbi = await getAbiFromHeadBlock(accountName);
        if (!savedAbi) {
            return null;
        }
        abi = savedAbi.abi;
    } else {
        try {
            abi = JSON.parse(savedAbi.abi);
        } catch (e) {
            console.log(e);
            return null;
        }
    }

    if (!abi) {
        return null;
    }

    const initialTypes = Serialize.createInitialTypes();
    let types;
    try {
        types = Serialize.getTypesFromAbi(initialTypes, abi);
    } catch (e) {
        let remapped = false;
        for (const struct of abi.structs) {
            for (const field of struct.fields) {
                if (abi_remapping[field.type]) {
                    field.type = abi_remapping[field.type];
                    remapped = true;
                }
            }
        }
        if (remapped) {
            try {
                types = Serialize.getTypesFromAbi(initialTypes, abi);
            } catch (e) {
                console.log('failed after remapping abi');
                console.log(accountName, block_num, check_action);
                console.log(e);
            }
        } else {
            console.log(accountName, block_num);
            console.log(e);
        }
    }
    const actions = new Map();
    for (const {name, type} of abi.actions) {
        actions.set(name, Serialize.getType(types, type));
    }
    const result = {types, actions, tables: abi.tables};
    if (check_action) {
        // console.log(actions);
        if (actions.has(check_action)) {
            // console.log(check_action, 'check type', actions.get(check_action).name);
            // console.log(abi);
            try {
                abieos['load_abi'](accountName, JSON.stringify(abi));
            } catch (e) {
                console.log(e);
            }
            contracts.set(accountName, {
                contract: result,
                valid_until: savedAbi.valid_until,
                valid_from: savedAbi.valid_from
            });
        }
    }
    return [result, abi];
}

async function deserializeActionAtBlock(action, block_num) {
    const contract = await getContractAtBlock(action.account, block_num, action.name);
    if (contract) {
        if (contract[0].actions.has(action.name)) {
            try {
                return Serialize.deserializeAction(
                    contract[0],
                    action.account,
                    action.name,
                    action.authorization,
                    action.data,
                    txEnc,
                    txDec
                );
            } catch (e) {
                console.log(e);
                return null;
            }
        } else {
            return null;
        }
    } else {
        return null;
    }
}

async function verifyLocalType(contract, type, block_num, field) {
    let _status;
    let resultType = abieos['get_type_for_' + field](contract, type);
    // console.log(contract, type, resultType);
    if (resultType === "NOT_FOUND") {
        // console.log(`${field} not found for ${type} on ${contract}`);
        const savedAbi = await fetchAbiHexAtBlockElastic(contract, block_num, false);
        if (savedAbi) {
            if (savedAbi[field + 's'].includes(type)) {
                if (savedAbi.abi_hex) {
                    _status = abieos['load_abi_hex'](contract, savedAbi.abi_hex);
                }
                // console.log('🔄  reloaded abi');
                if (_status) {
                    resultType = abieos['get_type_for_' + field](contract, type);
                    // console.log(`verifying ${field} type: ${resultType}`);
                    if (resultType === "NOT_FOUND") {
                        _status = false;
                    } else {
                        // console.log(`✅️  ${contract} abi cache updated at block ${block_num}`);
                        _status = true;
                        return [_status, resultType];
                    }
                }
            }
            // else {
            //     // console.log(`⚠️ ⚠️  ${field} "${type}" not found on saved abi for ${contract} at block ${block_num}!`);
            // }
        }
        // console.log(`Abi not indexed at or before block ${block_num} for ${contract}`);
        const currentAbi = await rpc.getRawAbi(contract);
        // console.log('Retrying with the current revision...');
        if (currentAbi.abi.byteLength > 0) {
            const abi_hex = Buffer.from(currentAbi.abi).toString('hex');
            _status = abieos['load_abi_hex'](contract, abi_hex);
        } else {
            _status = false;
        }
        if (_status === true) {
            resultType = abieos['get_type_for_' + field](contract, type);
            _status = resultType !== "NOT_FOUND"
            // if (resultType === "NOT_FOUND") {
            //     // console.log(`⚠️ ⚠️  Current ABI version for ${contract} doesn't contain the ${field} type ${type}`);
            //     _status = false;
            // } else {
            //     // console.log(`✅️  ${contract} abi cache updated at block ${block_num}`);
            //     _status = true;
            // }
        }
    } else {
        _status = true;
    }
    return [_status, resultType];
}

async function deserializeActionAtBlockNative(_action, block_num) {
    const [_status, actionType] = await verifyLocalType(_action.account, _action.name, block_num, "action");
    if (_status) {
        const result = abieos['bin_to_json'](_action.account, actionType, Buffer.from(_action.data, 'hex'));
        switch (result) {
            case 'PARSING_ERROR': {
                console.log(result, block_num, _action);
                break;
            }
            case 'NOT_FOUND': {
                console.log(result, block_num, _action);
                break;
            }
            case 'invalid string size': {
                console.log(result, _action.data);
                console.log(_action);
                break;
            }
            case 'read past end': {
                console.log(result, _action.data);
                console.log(_action);
                break;
            }
            default: {
                try {
                    return JSON.parse(result);
                } catch (e) {
                    console.log(e.message);
                    console.log('string >>', result);
                }
            }
        }
    }

    const fallbackResult = await deserializeActionAtBlock(_action, block_num);
    if (!fallbackResult) {
        console.log(`action fallback result: ${fallbackResult} @ ${block_num}`);
        console.log(_action);
    }
    return fallbackResult;
}

function attachActionExtras(action) {
    mLoader.processActionData(action);
}

function extractDeltaStruct(deltas) {
    const deltaStruct = {};
    for (const table_delta of deltas) {
        if (table_delta[0] === "table_delta_v0") {
            deltaStruct[table_delta[1].name] = table_delta[1].rows;
        }
    }
    return deltaStruct;
}

async function processDeltaContractRow(row, block_num) {
    try {
        const payload = deserializeNative('contract_row', row.data)[1];
        payload['present'] = row.present;
        payload['block_num'] = block_num;
        if (config.features['index_all_deltas'] || (payload.code === EOSIO_ALIAS || payload.table === 'accounts')) {
            const jsonRow = await processContractRowNative(payload, block_num);
            if (jsonRow['data']) {
                const indexableData = await processTableDelta(jsonRow, block_num);
                if (indexableData) {
                    if (!config.indexer['disable_indexing'] && config.features['index_deltas']) {
                        const payload = Buffer.from(JSON.stringify(jsonRow));
                        pushToDeltaQueue(payload);
                        temp_delta_counter++;
                        pushToDeltaStreamingQueue(payload, jsonRow);
                    }
                }
            }
        }
    } catch (e) {
        console.log(block_num, e);
    }
}

async function processDeltas(deltas, block_num, block_ts) {

    const deltaStruct = extractDeltaStruct(deltas);

    // if (Object.keys(deltaStruct).length > 4) {
    //     console.log(Object.keys(deltaStruct));
    // }

    // Check account deltas for ABI changes
    if (deltaStruct['account']) {
        const rows = deltaStruct['account'];
        for (const account_raw of rows) {
            const data = deserializeNative('account', account_raw.data);
            // const serialBuffer = createSerialBuffer(Buffer.from(account_raw.data));
            // const data = types.get('account').deserialize(serialBuffer);
            const account = data[1];
            if (account['abi'] !== '') {
                try {
                    const abiHex = account['abi'];
                    const abiBin = new Uint8Array(Buffer.from(abiHex, 'hex'));
                    const initialTypes = Serialize.createInitialTypes();
                    const abiDefTypes = Serialize.getTypesFromAbi(initialTypes, AbiDefinitions).get('abi_def');
                    const abiObj = abiDefTypes.deserialize(createSerialBuffer(abiBin));
                    const jsonABIString = JSON.stringify(abiObj);

                    const abi_actions = abiObj.actions.map(a => a.name);
                    const abi_tables = abiObj.tables.map(t => t.name);

                    console.log(`📝  New code for ${account['name']} at block ${block_num} with ${abi_actions.length} actions`);

                    const new_abi_object = {
                        account: account['name'],
                        block: block_num,
                        abi: jsonABIString,
                        abi_hex: abiHex,
                        actions: abi_actions,
                        tables: abi_tables
                    };
                    if (config['experimental']['PATCHED_SHIP']) {
                        new_abi_object['@timestamp'] = block_ts;
                        console.log(block_ts);
                    }
                    debugLog(`[Worker ${process.env.worker_id}] read ${account['name']} ABI at block ${block_num}`);
                    const q = index_queue_prefix + "_abis:1";
                    preIndexingQueue.push({
                        queue: q,
                        content: Buffer.from(JSON.stringify(new_abi_object))
                    });

                    // update locally cached abi
                    if (process.env['live_mode'] === 'true') {
                        console.log('Abi changed during live mode, updating local version...');
                        const abi_update_status = abieos['load_abi_hex'](account['name'], abiHex);
                        if (!abi_update_status) {
                            console.log(`Reload status: ${abi_update_status}`);
                        }
                    }

                    process.send({
                        event: 'save_abi',
                        data: new_abi_object,
                        live_mode: process.env['live_mode'],
                        worker_id: process.env.worker_id
                    });

                } catch (e) {
                    console.log(e);
                    console.log(account['abi'], block_num, account['name']);
                }
            } else {
                if (account.name === 'eosio') {
                    console.log(`---------- ${block_num} ----------------`);
                    console.log(account);
                }
            }
        }
    }

    if (!config.indexer['abi_scan_mode'] && config.indexer['process_deltas']) {

        // // Generated transactions
        // if (process.env.PROCESS_GEN_TX === 'true') {
        //     if (deltaStruct['generated_transaction']) {
        //         const rows = deltaStruct['generated_transaction'];
        //         for (const gen_trx of rows) {
        //             const serialBuffer = createSerialBuffer(gen_trx.data);
        //             const data = types.get('generated_transaction').deserialize(serialBuffer);
        //             await processDeferred(data[1], block_num);
        //         }
        //     }
        // }

        // Contract Rows
        if (deltaStruct['contract_row']) {
            for (const row of deltaStruct['contract_row']) {
                await processDeltaContractRow(row, block_num);
            }
        }

        // if (deltaStruct['permission_link']) {
        //     if (deltaStruct['permission_link'].length > 0) {
        //         for (const permission_link of deltaStruct['permission_link']) {
        //             const serialBuffer = createSerialBuffer(permission_link.data);
        //             const data = types.get('permission_link').deserialize(serialBuffer);
        //             console.log(permission_link);
        //             const payload = {
        //                 present: permission_link.present,
        //                 account: data[1].account,
        //                 code: data[1].code,
        //                 action: data[1]['message_type'],
        //                 permission: data[1]['required_permission']
        //             };
        //             console.log(payload);
        //         }
        //     }
        // }

        // if (deltaStruct['permission']) {
        //     if (deltaStruct['permission'].length > 0) {
        //         for (const permission of deltaStruct['permission']) {
        //             const serialBuffer = createSerialBuffer(permission.data);
        //             const data = types.get('permission').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['contract_index64']) {
        //     if (deltaStruct['contract_index64'].length > 0) {
        //         for (const contract_index64 of deltaStruct['contract_index64']) {
        //             const serialBuffer = createSerialBuffer(contract_index64.data);
        //             const data = types.get('contract_index64').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }
        //
        // if (deltaStruct['contract_index128']) {
        //     if (deltaStruct['contract_index128'].length > 0) {
        //         for (const contract_index128 of deltaStruct['contract_index128']) {
        //             const serialBuffer = createSerialBuffer(contract_index128.data);
        //             const data = types.get('contract_index128').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['account_metadata']) {
        //     if (deltaStruct['account_metadata'].length > 0) {
        //         for (const account_metadata of deltaStruct['account_metadata']) {
        //             const serialBuffer = createSerialBuffer(account_metadata.data);
        //             const data = types.get('account_metadata').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['resource_limits']) {
        //     if (deltaStruct['resource_limits'].length > 0) {
        //         for (const resource_limits of deltaStruct['resource_limits']) {
        //             const serialBuffer = createSerialBuffer(resource_limits.data);
        //             const data = types.get('resource_limits').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['resource_usage']) {
        //     if (deltaStruct['resource_usage'].length > 0) {
        //         for (const resource_usage of deltaStruct['resource_usage']) {
        //             const serialBuffer = createSerialBuffer(resource_usage.data);
        //             const data = types.get('resource_usage').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['resource_limits_state']) {
        //     if (deltaStruct['resource_limits_state'].length > 0) {
        //         for (const resource_limits_state of deltaStruct['resource_limits_state']) {
        //             const serialBuffer = createSerialBuffer(resource_limits_state.data);
        //             const data = types.get('resource_limits_state').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }

        // if (deltaStruct['contract_table']) {
        //     if (deltaStruct['contract_table'].length > 0) {
        //         for (const contract_table of deltaStruct['contract_table']) {
        //             const serialBuffer = createSerialBuffer(contract_table.data);
        //             const data = types.get('contract_table').deserialize(serialBuffer);
        //             console.log(prettyjson.render(data));
        //         }
        //     }
        // }
    }
}

async function processContractRowNative(row, block) {

    const [_status, tableType] = await verifyLocalType(row['code'], row['table'], block, "table");

    let debugFallback;

    if (_status) {
        let result;
        if (typeof row.value === 'string') {
            result = abieos['hex_to_json'](row['code'], tableType, row.value);
        } else {
            result = abieos['bin_to_json'](row['code'], tableType, row.value);
        }
        switch (result) {
            case "Extra data": {
                console.log(`Extra data on row with type "${tableType}"`);
                console.log(row);
                debugFallback = true;
                break;
            }
            case 'PARSING_ERROR': {
                console.log(`Row parsing error`);
                break;
            }
            default: {
                try {
                    row['data'] = JSON.parse(result);
                    delete row.value;
                    return row;
                } catch (e) {
                    console.log(`JSON Parse error: ${e.message} | string: "${result}"`);
                    console.log('------------- contract row ----------------');
                    console.log(row);
                    console.log('-------------------------------------------')
                }
            }
        }
    }

    const fallbackResult = await processContractRow(row, block);
    if (debugFallback) {
        console.log('delta fallback', fallbackResult);
    }
    return fallbackResult;
}

async function processContractRow(row, block) {
    const row_sb = createSerialBuffer(Serialize.hexToUint8Array(row['value']));
    const tableType = await getTableType(row['code'], row['table'], block);
    let error;
    if (tableType) {
        try {
            row['data'] = tableType.deserialize(row_sb);
            delete row.value;
            return row;
        } catch (e) {
            error = e.message;
        }
    }

    process.send({
        event: 'ds_error',
        data: {
            type: 'delta_ds_error',
            block: block,
            code: row['code'],
            table: row['table'],
            message: error
        }
    });

    return row;
}

async function getTableType(code, table, block) {
    let abi, contract, abi_tables;
    [contract, abi] = await getContractAtBlock(code, block);
    if (!contract.tables) {
        abi = (await getAbiAtBlock(code, block)).abi;
        abi_tables = abi.tables;
    } else {
        abi_tables = contract.tables
    }
    let this_table, type;
    for (let t of abi_tables) {
        if (t.name === table) {
            this_table = t;
            break;
        }
    }
    if (this_table) {
        type = this_table.type;
    } else {
        // console.error(`Could not find table "${table}" in the abi for ${code} at block ${block}`);
        // retry with the current abi
        const currentABI = await getAbiFromHeadBlock(code);
        if (!currentABI) {
            return;
        }
        abi_tables = currentABI.abi.tables;
        for (let t of abi_tables) {
            if (t.name === table) {
                this_table = t;
                break;
            }
        }
        if (this_table) {
            type = this_table.type;
            const initialTypes = Serialize.createInitialTypes();
            contract.types = Serialize.getTypesFromAbi(initialTypes, currentABI.abi);
        } else {
            return;
        }
    }
    let cType = contract.types.get(type);
    if (!cType) {
        if (types.has(type)) {
            cType = types.get(type);
        } else {
            if (type === 'self_delegated_bandwidth') {
                cType = contract.types.get('delegated_bandwidth')
            }
        }
        if (!cType) {
            console.log(code, block);
            console.log(`code:${code} | table:${table} | block:${block} | type:${type}`);
            console.log(Object.keys(contract));
            console.log(Object.keys(abi));
        }
    }
    return cType;
}

// Register table handlers
const tableHandlers = {};

tableHandlers[EOSIO_ALIAS + ':voters'] = async (delta) => {
    delta['@voters'] = {};
    delta['@voters']['is_proxy'] = delta.data['is_proxy'];
    delete delta.data['is_proxy'];
    delete delta.data['owner'];
    if (delta.data['proxy'] !== "") {
        delta['@voters']['proxy'] = delta.data['proxy'];
    }
    delete delta.data['proxy'];
    if (delta.data['producers'].length > 0) {
        delta['@voters']['producers'] = delta.data['producers'];
    }
    delete delta.data['producers'];
    delta['@voters']['last_vote_weight'] = parseFloat(delta.data['last_vote_weight']);
    delete delta.data['last_vote_weight'];
    delta['@voters']['proxied_vote_weight'] = parseFloat(delta.data['proxied_vote_weight']);
    delete delta.data['proxied_vote_weight'];
    delta['@voters']['staked'] = parseInt(delta.data['staked'], 10) / 10000;
    delete delta.data['staked'];
    if (config.features.tables.voters) {
        await storeVoter(delta);
    }
};

tableHandlers[EOSIO_ALIAS + ':global'] = async (delta) => {
    const data = delta['data'];
    delta['@global.data'] = {
        last_name_close: data['last_name_close'],
        last_pervote_bucket_fill: data['last_pervote_bucket_fill'],
        last_producer_schedule_update: data['last_producer_schedule_update'],
        perblock_bucket: parseFloat(data['perblock_bucket']) / 10000,
        pervote_bucket: parseFloat(data['perblock_bucket']) / 10000,
        total_activated_stake: parseFloat(data['total_activated_stake']) / 10000,
        total_producer_vote_weight: parseFloat(data['total_producer_vote_weight']),
        total_ram_kb_reserved: parseFloat(data['total_ram_bytes_reserved']) / 1024,
        total_ram_stake: parseFloat(data['total_ram_stake']) / 10000,
        total_unpaid_blocks: data['total_unpaid_blocks']
    };
    delete delta['data'];
};

tableHandlers[EOSIO_ALIAS + ':producers'] = async (delta) => {
    const data = delta['data'];
    delta['@producers'] = {
        total_votes: parseFloat(data['total_votes']),
        is_active: data['is_active'],
        unpaid_blocks: data['unpaid_blocks']
    };
    delete delta['data'];
};

tableHandlers[EOSIO_ALIAS + ':userres'] = async (delta) => {
    const data = delta['data'];
    const net = parseFloat(data['net_weight'].split(" ")[0]);
    const cpu = parseFloat(data['cpu_weight'].split(" ")[0]);
    delta['@userres'] = {
        owner: data['owner'],
        net_weight: net,
        cpu_weight: cpu,
        total_weight: parseFloat((net + cpu).toFixed(4)),
        ram_bytes: parseInt(data['ram_bytes'])
    };
    delete delta['data'];
    // console.log(delta);
};

tableHandlers[EOSIO_ALIAS + ':delband'] = async (delta) => {
    const data = delta['data'];
    const net = parseFloat(data['net_weight'].split(" ")[0]);
    const cpu = parseFloat(data['cpu_weight'].split(" ")[0]);
    delta['@delband'] = {
        from: data['from'],
        to: data['to'],
        net_weight: net,
        cpu_weight: cpu,
        total_weight: parseFloat((net + cpu).toFixed(4))
    };
    delete delta['data'];
    // console.log(delta);
};

tableHandlers[EOSIO_ALIAS + '.msig:proposal'] = async (delta) => {
    // decode packed_transaction
    delta['@proposal'] = {
        proposal_name: delta['data']['proposal_name']
    };
    delete delta['data'];
};

tableHandlers[EOSIO_ALIAS + '.msig:approvals'] = async (delta) => {
    delta['@approvals'] = {
        proposal_name: delta['data']['proposal_name'],
        requested_approvals: delta['data']['requested_approvals'],
        provided_approvals: delta['data']['provided_approvals']
    };
    delete delta['data'];
    if (config.features.tables.proposals) {
        await storeProposal(delta);
    }
};

tableHandlers[EOSIO_ALIAS + '.msig:approvals2'] = async (delta) => {
    delta['@approvals'] = {
        proposal_name: delta['data']['proposal_name'],
        requested_approvals: delta['data']['requested_approvals'].map((item) => {
            return {actor: item.level.actor, permission: item.level.permission, time: item.time};
        }),
        provided_approvals: delta['data']['provided_approvals'].map((item) => {
            return {actor: item.level.actor, permission: item.level.permission, time: item.time};
        })
    };
    if (config.features.tables.proposals) {
        await storeProposal(delta);
    }
};

tableHandlers['*:accounts'] = async (delta) => {
    if (typeof delta['data']['balance'] === 'string') {
        try {
            const [amount, symbol] = delta['data']['balance'].split(" ");
            delta['@accounts'] = {
                amount: parseFloat(amount),
                symbol: symbol
            };
            delete delta.data['balance'];
        } catch (e) {
            console.log(delta);
            console.log(e);
        }
    }
    if (config.features.tables.accounts) {
        await storeAccount(delta);
    }
};

async function storeProposal(data) {
    const proposalDoc = {
        proposer: data['scope'],
        proposal_name: data['@approvals']['proposal_name'],
        requested_approvals: data['@approvals']['requested_approvals'],
        provided_approvals: data['@approvals']['provided_approvals'],
        executed: data.present === false,
        primary_key: data['primary_key'],
        block_num: data['block_num']
    };
    // console.log('-------------- PROPOSAL --------------');
    // console.log(prettyjson.render(proposalDoc));
    if (!config.indexer['disable_indexing']) {
        const q = index_queue_prefix + "_table_proposals:" + (tbl_prop_emit_idx);
        preIndexingQueue.push({
            queue: q,
            content: Buffer.from(JSON.stringify(proposalDoc))
        });
        tbl_prop_emit_idx++;
        if (tbl_prop_emit_idx > (n_ingestors_per_queue)) {
            tbl_prop_emit_idx = 1;
        }
    }
}

async function storeVoter(data) {
    const voterDoc = {
        "voter": data['payer'],
        "last_vote_weight": data['@voters']['last_vote_weight'],
        "is_proxy": data['@voters']['is_proxy'],
        "proxied_vote_weight": data['@voters']['proxied_vote_weight'],
        "staked": data['@voters']['staked'],
        "primary_key": data['primary_key'],
        "block_num": data['block_num']
    };
    if (data['@voters']['proxy']) {
        voterDoc.proxy = data['@voters']['proxy'];
    }
    if (data['@voters']['producers']) {
        voterDoc.producers = data['@voters']['producers'];
    }

    // console.log('-------------- VOTER --------------');
    // console.log(prettyjson.render(data));

    if (!config.indexer['disable_indexing']) {
        const q = index_queue_prefix + "_table_voters:" + (tbl_vote_emit_idx);
        preIndexingQueue.push({
            queue: q,
            content: Buffer.from(JSON.stringify(voterDoc))
        });
        tbl_vote_emit_idx++;
        if (tbl_vote_emit_idx > (n_ingestors_per_queue)) {
            tbl_vote_emit_idx = 1;
        }
    }
}

async function storeAccount(data) {
    const accountDoc = {
        "code": data['code'],
        "scope": data['scope'],
        "primary_key": data['primary_key'],
        "block_num": data['block_num']
    };
    if (data['@accounts']) {
        accountDoc['amount'] = data['@accounts']['amount'];
        accountDoc['symbol'] = data['@accounts']['symbol'];
    }

    // console.log('-------------- ACCOUNT --------------');
    // console.log(prettyjson.render(accountDoc));

    if (!config.indexer['disable_indexing']) {
        const q = index_queue_prefix + "_table_accounts:" + (tbl_acc_emit_idx);
        preIndexingQueue.push({
            queue: q,
            content: Buffer.from(JSON.stringify(accountDoc))
        });
        tbl_acc_emit_idx++;
        if (tbl_acc_emit_idx > (n_ingestors_per_queue)) {
            tbl_acc_emit_idx = 1;
        }
    }
}

async function processTableDelta(data) {
    if (data['table']) {
        data['primary_key'] = String(data['primary_key']);
        let allowIndex;
        let handled = false;
        const key = `${data.code}:${data.table}`;
        if (tableHandlers[key]) {
            await tableHandlers[key](data);
            handled = true;
        }
        if (tableHandlers[`${data.code}:*`]) {
            await tableHandlers[`${data.code}:*`](data);
            handled = true;
        }
        if (tableHandlers[`*:${data.table}`]) {
            await tableHandlers[`*:${data.table}`](data);
            handled = true;
        }
        if (!handled && config.features['index_all_deltas']) {
            allowIndex = true;
        } else {
            allowIndex = handled;
        }
        return allowIndex;
    }
}

function createSerialBuffer(inputArray) {
    return new Serialize.SerialBuffer({textEncoder: txEnc, textDecoder: txDec, array: inputArray});
}

// async function processDeferred(data, block_num) {
//     if (data['packed_trx']) {
//         const sb_trx = createSerialBuffer(Serialize.hexToUint8Array(data['packed_trx']));
//         const data_trx = types.get('transaction').deserialize(sb_trx);
//         data = _.omit(_.merge(data, data_trx), ['packed_trx']);
//         data['actions'] = await api.deserializeActions(data['actions']);
//         data['trx_id'] = data['trx_id'].toLowerCase();
//         if (data['delay_sec'] > 0) {
//             console.log(`-------------- DELAYED ${block_num} -----------------`);
//             console.log(prettyjson.render(data));
//         }
//     }
// }

async function getAbiFromHeadBlock(code) {
    let _abi;
    try {
        _abi = (await rpc.get_abi(code)).abi;
    } catch (e) {
        console.log(e);
    }
    return {abi: _abi, valid_until: null, valid_from: null};
}

async function fetchAbiHexAtBlockElastic(contract_name, last_block, get_json) {
    try {
        const _includes = ["actions", "tables"];
        if (get_json) {
            _includes.push("abi");
        } else {
            _includes.push("abi_hex");
        }
        // const t_start = process.hrtime.bigint();
        const queryResult = await client.search({
            index: `${queue_prefix}-abi-*`,
            body: {
                size: 1,
                query: {
                    bool: {
                        must: [
                            {term: {account: contract_name}},
                            {range: {block: {lte: last_block}}}
                        ]
                    }
                },
                sort: [{block: {order: "desc"}}],
                _source: {includes: _includes}
            }
        });
        // const t_end = process.hrtime.bigint();
        const results = queryResult.body.hits.hits;
        // const duration = (Number(t_end - t_start) / 1000 / 1000).toFixed(2);
        if (results.length > 0) {
            // console.log(`fetch abi from elastic took: ${duration} ms`);
            return results[0]._source;
        } else {
            return null;
        }
    } catch (e) {
        console.log(e);
        return null;
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

            // fetch from redis
            // const t_start = process.hrtime.bigint();
            const cachedAbiAtBlock = await getAsync(config.settings.chain + ":" + lastblock + ":" + code);
            // const t_end = process.hrtime.bigint();
            // console.log(`fetch abi from redis took: ${t_end - t_start} ns`);

            let abi;
            if (!cachedAbiAtBlock) {
                console.log('remote abi fetch [1]', code, block_num);
                return await getAbiFromHeadBlock(code);
            } else {
                try {
                    abi = JSON.parse(cachedAbiAtBlock);
                    return {abi: abi, valid_until: validity, valid_from: lastblock};
                } catch (e) {
                    console.log('failed to parse saved ABI', code, block_num);
                    console.log(cachedAbiAtBlock);
                    console.log('----------  END CACHED ABI ------------');
                    return {abi: null, valid_until: null, valid_from: null};
                }
            }
        } else {
            console.log('remote abi fetch [2]', code, block_num);
            return await getAbiFromHeadBlock(code);
        }
    } else {
        const ref_time = Date.now();
        let _abi;
        try {
            _abi = await api.getAbi(code);
            const elapsed_time = (Date.now() - ref_time);
            if (elapsed_time > 10) {
                console.log(`[DS ${process.env.worker_id}] remote abi fetch [type 3] for ${code} at ${block_num} took too long (${elapsed_time}ms)`);
            }
        } catch (e) {
            if (code === EOSIO_ALIAS + '.rex') {
                _abi = RexAbi;
            } else {
                console.log(e);
                return {abi: null, valid_until: null, valid_from: null};
            }
        }
        return {abi: _abi, valid_until: null, valid_from: null};
    }
}

function assertQueues() {
    if (ch) {
        ch_ready = true;
        if (preIndexingQueue.paused) {
            preIndexingQueue.resume();
        }
        ch.on('close', () => {
            ch_ready = false;
            preIndexingQueue.pause();
        });
    }

    // input queues
    if (process.env['live_mode'] === 'false') {
        for (let i = 0; i < n_deserializers; i++) {
            ch.assertQueue(queue + ":" + (i + 1), {
                durable: true
            });
        }
    }

    // output
    let qIdx = 0;
    index_queues.forEach((q) => {
        let n = n_ingestors_per_queue;
        if (q.type === 'abi') n = 1;
        qIdx = 0;
        for (let i = 0; i < n; i++) {
            let m = 1;
            if (q.type === 'action' || q.type === 'delta') {
                m = action_indexing_ratio;
            }
            for (let j = 0; j < m; j++) {
                ch.assertQueue(q.name + ":" + (qIdx + 1), {durable: true});
                qIdx++;
            }
        }
    });
}

function initConsumer() {
    if (ch_ready) {
        ch.prefetch(deserializerPrefetch);
        ch.consume(process.env['worker_queue'], (data) => {
            consumerQueue.push(data);
        });
    }
}

function onIpcMessage(msg) {
    switch (msg.event) {
        case 'initialize_abi': {
            abi = JSON.parse(msg.data);
            abieos['load_abi']("0", msg.data);
            const initialTypes = Serialize.createInitialTypes();
            types = Serialize.getTypesFromAbi(initialTypes, abi);
            abi.tables.map(table => tables.set(table.name, table.type));
            initConsumer();
            break;
        }
        case 'update_abi': {
            if (msg.abi) {
                if (msg.abi.abi_hex) {
                    abieos['load_abi_hex'](msg.abi.account, msg.abi.abi_hex);
                    console.log(`Worker ${process.env.worker_id} updated the abi for ${msg.abi.account}`);
                }
            }
            break;
        }
        case 'connect_ws': {
            allowStreaming = true;
            break;
        }
        case 'new_range': {
            break;
        }
        default: {
            console.log('-----------> IPC Message <--------------');
            console.log(msg);
            console.log('----------------------------------------');
        }
    }
}

async function run() {

    // Check for attached debbuger
    if (/--inspect/.test(process.execArgv.join(' '))) {
        const inspector = require('inspector');
        console.log('DEBUGGER', process.env['queue'], inspector.url());
    }

    // Monitor DS Counter
    setInterval(() => {
        process.send({
            event: 'ds_report',
            actions: temp_ds_counter,
            deltas: temp_delta_counter
        });
        temp_ds_counter = 0;
        temp_delta_counter = 0;
    }, 1000);

    // setInterval(() => {
    //     debugLog(` ${process.env.worker_id} - Contract Map Count: ${contracts.size}`);
    //     contractHitMap.forEach((value, key) => {
    //         debugLog(`Code: ${key} - Hits: ${value.hits}`);
    //         if (value.hits < 100) {
    //             contracts.delete(key);
    //         }
    //     });
    // }, 25000);

    cachedMap = JSON.parse(await getAsync(config.settings.chain + ":" + 'abi_cache'));
    rpc = manager.nodeosJsonRPC;
    const chain_data = await rpc.get_info();
    chainID = chain_data.chain_id;
    api = new Api({
        rpc,
        signatureProvider: null,
        chainId: chain_data.chain_id,
        textDecoder: txDec,
        textEncoder: txEnc,
    });

    // Init ES Client
    client = manager.elasticsearchClient;

    // Connect to RabbitMQ (amqplib)
    [ch, cch] = await manager.createAMQPChannels((channels) => {
        [ch, cch] = channels;
        assertQueues();
        initConsumer();
    });

    // Init Queues
    assertQueues();

    // Handle IPC Messages
    process.on("message", (msg) => {
        onIpcMessage(msg);
    });
}

module.exports = {run};
