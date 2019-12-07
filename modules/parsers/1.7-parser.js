const prettyjson = require("prettyjson");
const {action_blacklist} = require('../../definitions/blacklists');
const {action_whitelist} = require('../../definitions/whitelists');
const {deserialize, debugLog, unzipAsync} = require('../../helpers/functions');
const {TextEncoder, TextDecoder} = require('util');
const txDec = new TextDecoder();
const txEnc = new TextEncoder();
const chain = process.env.CHAIN;

function checkBlacklist(act) {
    if (action_blacklist.has(`${chain}::${act['account']}::*`)) {
        return true;
    } else return action_blacklist.has(`${chain}::${act['account']}::${act['name']}`);
}

function checkWhitelist(act) {
    if (action_whitelist.has(`${chain}::${act['account']}::*`)) {
        return true;
    } else return action_whitelist.has(`${chain}::${act['account']}::${act['name']}`);
}

const reading_mode = process.env.live_mode;

async function actionParser(common, ts, action, trx_data, _actDataArray,
                            _processedTraces, full_trace, parent, current_ord) {
    const {trx_id, block_num, producer, cpu_usage_us, net_usage_words} = trx_data;
    let act = action['act'];

    // Include ordinals
    if (parent === null) {
        action['creator_action_ordinal'] = 0;
        action['action_ordinal'] = 1;
    } else {
        action['creator_action_ordinal'] = parent;
        if (current_ord !== null) {
            action['action_ordinal'] = current_ord;
        }
    }

    // abort if blacklisted
    if (checkBlacklist(act)) {
        return false;
    }

    if (action_whitelist.size > 0) {
        if (!checkWhitelist(act)) {
            return false;
        }
    }

    const original_act = Object.assign({}, act);
    const actions = [];
    actions.push(act);
    let ds_act;
    try {
        ds_act = await common.deserializeActionsAtBlock(actions, block_num);
        action['act'] = ds_act[0];
        common.attachActionExtras(action);
        // report deserialization event
        process.send({event: 'ds_action'});
    } catch (e) {
        // write error to CSV
        console.log(e);
        process.send({
            event: 'ds_error',
            data: {
                type: 'action_ds_error',
                block: block_num,
                account: act.account,
                action: act.name,
                gs: parseInt(action['receipt'][1]['global_sequence'], 10),
                message: e.message
            }
        });
        action['act'] = original_act;
        action['act']['data'] = Buffer.from(action['act']['data']).toString('hex');
    }

    action['@timestamp'] = ts;
    action['block_num'] = block_num;
    action['producer'] = producer;
    action['trx_id'] = trx_id;

    if (action['account_ram_deltas'].length === 0) {
        delete action['account_ram_deltas'];
    }
    if (action['console'] === '') {
        delete action['console'];
    }
    if (action['except'] === null) {
        if (!action['receipt']) {
            console.log(full_trace.status);
            console.log(action);
        }
        action['receipt'] = action['receipt'][1];
        action['global_sequence'] = parseInt(action['receipt']['global_sequence'], 10);
        delete action['except'];
        delete action['error_code'];

        // add usage data to the first action on the transaction
        if (action['action_ordinal'] === 1 && action['creator_action_ordinal'] === 0) {
            action['cpu_usage_us'] = cpu_usage_us;
            action['net_usage_words'] = net_usage_words;
        }

        if (action['inline_traces']) {
            let newOrds = action['action_ordinal'] + 1;
            for (const inline of action['inline_traces']) {
                await actionParser(common, ts, inline[1], trx_data,
                    _actDataArray, _processedTraces, full_trace,
                    action['action_ordinal'], newOrds);
                newOrds++;
            }
        }
        delete action['inline_traces'];
        _processedTraces.push(action);

    } else {
        console.log(action);
    }
    return true;
}

async function messageParser(common, messages, types, ch, ch_ready) {
    for (const message of messages) {
        const ds_msg = deserialize('result', message.content, txEnc, txDec, types);
        const res = ds_msg[1];
        let block, traces = [], deltas = [];
        if (res.block && res.block.length) {
            block = deserialize('signed_block', res.block, txEnc, txDec, types);
            if (block === null) {
                console.log(res);
            }
        }
        if (res['traces'] && res['traces'].length) {
            traces = deserialize(
                'transaction_trace[]',
                await unzipAsync(res['traces']),
                txEnc,
                txDec,
                types
            );
        }
        if (res['deltas'] && res['deltas'].length) {
            deltas = deserialize(
                'table_delta[]',
                await unzipAsync(res['deltas']),
                txEnc,
                txDec,
                types
            );
        }
        try {
            const t0 = Date.now();
            const result = await common.processBlock(res, block, traces, deltas);
            const elapsedTime = Date.now() - t0;
            if (elapsedTime > 10) {
                debugLog(`[WARNING] Deserialization time for block ${result['block_num']} was too high, time elapsed ${elapsedTime}ms`);
            }
            if (result) {
                const evPayload = {
                    event: 'consumed_block',
                    block_num: result['block_num'],
                    live: reading_mode
                };
                if (block) {
                    evPayload["producer"] = block['producer'];
                }
                process.send(evPayload);
            } else {
                console.log('Empty message. No block');
                console.log(_.omit(res, ['block', 'traces', 'deltas']));
            }
            if (ch_ready) {
                ch.ack(message);
            }
        } catch (e) {
            console.log(e);
            if (ch_ready) {
                ch.nack(message);
            }
        }
    }
}

module.exports = {actionParser, messageParser};
