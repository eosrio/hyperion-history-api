import {BaseParser} from "./base-parser";
import MainDSWorker from "../../workers/deserializer";
import {Message} from "amqplib";
import DSPoolWorker from "../../workers/ds-pool";
import {TrxMetadata} from "../../interfaces/trx-metadata";
import {ActionTrace} from "../../interfaces/action-trace";
import {hLog} from "../../helpers/common_functions";

export default class HyperionParser extends BaseParser {

    public async parseAction(worker: DSPoolWorker, ts, action: ActionTrace, trx_data: TrxMetadata, _actDataArray, _processedTraces: ActionTrace[], full_trace, usageIncluded): Promise<boolean> {
        let act = action.act;
        if (this.checkBlacklist(act)) return false;
        if (this.filters.action_whitelist.size > 0) {
            if (!this.checkWhitelist(act)) return false;
        }
        const original_act = Object.assign({}, act);
        let ds_act, error_message;
        try {
            ds_act = await worker.common.deserializeActionAtBlockNative(worker, act, trx_data.block_num);
        } catch (e) {
            console.log(e);
            error_message = e.message;
        }

        if (ds_act) {
            action.act.data = ds_act;
            worker.common.attachActionExtras(worker, action);
        } else {
            action['act'] = original_act;
            if (typeof action.act.data !== 'string') {
                action.act.data = Buffer.from(action.act.data).toString('hex');
            }
            process.send({
                event: 'ds_error',
                data: {
                    type: 'action_ds_error',
                    block: trx_data.block_num,
                    account: act.account,
                    action: act.name,
                    gs: parseInt(action.receipt[1].global_sequence, 10),
                    message: error_message
                }
            });
        }

        action["@timestamp"] = ts;
        action.block_num = trx_data.block_num;
        action.producer = trx_data.producer;
        action.trx_id = trx_data.trx_id;

        if (action.account_ram_deltas.length === 0) {
            delete action.account_ram_deltas;
        }

        if (action.except === null) {
            if (!action.receipt) {
                console.log(full_trace.status);
                console.log(action);
            }
            action.receipt = action.receipt[1];
            action.global_sequence = parseInt(action.receipt.global_sequence, 10);
            delete action.except;
            delete action.error_code;

            // add usage data to the first action on the transaction
            if (!usageIncluded.status) {
                action.cpu_usage_us = trx_data.cpu_usage_us;
                action.net_usage_words = trx_data.net_usage_words;
                usageIncluded.status = true;
            }
            _processedTraces.push(action);
        } else {
            hLog(action);
        }
        return true;
    }

    public async parseMessage(worker: MainDSWorker, messages: Message[]): Promise<void> {
        for (const message of messages) {
            const ds_msg = worker.deserializeNative('result', message.content);
            if (!ds_msg) {
                if (worker.ch_ready) {
                    worker.ch.nack(message);
                    throw new Error('failed to deserialize datatype=result');
                }
            }
            const res = ds_msg[1];
            let block, traces = [], deltas = [];
            if (res.block && res.block.length) {
                block = worker.deserializeNative('signed_block', res.block);
                if (block === null) {
                    console.log(res);
                    process.exit(1);
                }
            }
            if (res['traces'] && res['traces'].length) {
                try {
                    traces = worker.deserializeNative('transaction_trace[]', res['traces']);
                } catch (e) {
                    console.log(e);
                }
            }
            if (res['deltas'] && res['deltas'].length) {
                deltas = worker.deserializeNative('table_delta[]', res['deltas']);
            }
            let result;
            try {
                result = await worker.processBlock(res, block, traces, deltas);
                if (result) {
                    const evPayload = {
                        event: 'consumed_block',
                        block_num: result['block_num'],
                        lib: res.last_irreversible.block_num,
                        live: process.env.live_mode
                    };
                    if (block) {
                        evPayload["producer"] = block['producer'];
                        evPayload["schedule_version"] = block['schedule_version'];
                    }
                    process.send(evPayload);
                } else {
                    console.log('Empty message. No block');
                }
                if (worker.ch_ready) {
                    worker.ch.ack(message);
                }
            } catch (e) {
                console.log(e);
                if (worker.ch_ready) {
                    worker.ch.nack(message);
                }
                process.exit(1);
            }
        }
    }

}
