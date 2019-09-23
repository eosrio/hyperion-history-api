const {action_blacklist} = require('../../definitions/blacklists');
const {action_whitelist} = require('../../definitions/whitelists');
const {deserialize, debugLog} = require('../../helpers/functions');
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

module.exports = {
    actionParser: async (common, ts, action, trx_id, block_num, prod, _actDataArray, _processedTraces, full_trace) => {
        let act = action['act'];

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
        // act.data = new Uint8Array(Object.values(act.data));
        const actions = [];
        actions.push(act);
        let ds_act;
        try {
            ds_act = await common.deserializeActionsAtBlock(actions, block_num);
            action['act'] = ds_act[0];
            common.attachActionExtras(action);
        } catch (e) {
            console.log('----------------- DESERIALIZATION ERROR ----------------');
            console.log(action);
            console.log(e);
            console.log('---------------------------------------------------------');
            process.send({
                t: 'ds_fail',
                v: {gs: action['receipt']['global_sequence']}
            });
            action['act'] = original_act;
            action['act']['data'] = Buffer.from(action['act']['data']).toString('hex');
        }
        process.send({event: 'ds_action'});
        action['@timestamp'] = ts;
        action['block_num'] = block_num;
        action['producer'] = prod;
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
            _processedTraces.push(action);
        } else {
            console.log(action);
        }
        return true;
    },
    messageParser: async (common, messages, types, ch, ch_ready) => {
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
                traces = deserialize('transaction_trace[]', res['traces'], txEnc, txDec, types);
            }
            if (res['deltas'] && res['deltas'].length) {
                deltas = deserialize('table_delta[]', res['deltas'], txEnc, txDec, types);
            }
            let result;
            try {
                const t0 = Date.now();
                result = await common.processBlock(res, block, traces, deltas);
                const elapsedTime = Date.now() - t0;
                if (elapsedTime > 10) {
                    debugLog(`[WARNING] Deserialization time for block ${result['block_num']} was too high, time elapsed ${elapsedTime}ms`);
                }
                if (result) {
                    process.send({
                        event: 'consumed_block',
                        block_num: result['block_num']
                    });
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
};
