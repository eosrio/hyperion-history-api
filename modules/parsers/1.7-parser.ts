import {BaseParser} from "./base-parser";
import MainDSWorker from "../../workers/deserializer";
import {Message} from "amqplib";
import DSPoolWorker from "../../workers/ds-pool";
import {TrxMetadata} from "../../interfaces/trx-metadata";
import {ActionTrace} from "../../interfaces/action-trace";
import {hLog} from "../../helpers/common_functions";
import {unzip} from "zlib";
import {omit} from "lodash";

async function unzipAsync(data) {
    return new Promise((resolve, reject) => {
        const buf = Buffer.from(data, 'hex');
        unzip(buf, (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        })
    });
}

export default class HyperionParser extends BaseParser {

    flatten = true;

    public async parseAction(worker: DSPoolWorker, ts, action: ActionTrace, trx_data: TrxMetadata, _actDataArray, _processedTraces: ActionTrace[], full_trace, usageIncluded): Promise<boolean> {

        // check filters
        if (this.checkBlacklist(action.act)) return false;
        if (this.filters.action_whitelist.size > 0) {
            if (!this.checkWhitelist(action.act)) return false;
        }

        await this.deserializeActionData(worker, action, trx_data);

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
            delete action.elapsed;
            delete action.context_free;
            delete action.level;

            if (!usageIncluded.status) {
                this.extendFirstAction(worker, action, trx_data, full_trace, usageIncluded);
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
                if (!block) {
                    hLog('null block', res);
                    process.exit(1);
                }
            }
            if (res['traces'] && res['traces'].length) {
                try {
                    traces = worker.deserializeNative(
                        'transaction_trace[]',
                        await unzipAsync(res['traces'])
                    );
                } catch (e:any) {
                    hLog(e);
                }
            }
            if (res['deltas'] && res['deltas'].length) {
                try {
                    deltas = worker.deserializeNative(
                        'table_delta[]',
                        await unzipAsync(res['deltas'])
                    );
                } catch (e:any) {
                    hLog(e);
                }
            }
            let result;
            try {
                result = await worker.processBlock(res, block, traces, deltas);
                if (result) {
                    const evPayload = {
                        event: 'consumed_block',
                        block_num: result['block_num'],
                        block_id: result['block_id'],
                        trx_ids: result['trx_ids'],
                        lib: res.last_irreversible.block_num,
                        live: process.env.live_mode
                    };
                    if (block) {
                        evPayload["producer"] = block['producer'];
                        evPayload["schedule_version"] = block['schedule_version'];
                    }
                    process.send(evPayload);
                } else {
                    hLog(`ERROR: Block data not found for #${res['this_block']['block_num']}`);
                }
                if (worker.ch_ready) {
                    worker.ch.ack(message);
                }
            } catch (e:any) {
                console.log(e);
                if (worker.ch_ready) {
                    worker.ch.nack(message);
                }
                process.exit(1);
            }
        }
    }

    async flattenInlineActions(action_traces: any[], level: number, trace_counter: any, parent_index: number): Promise<any[]> {
        const arr = [];
        const nextLevel = [];
        for (const action_trace of action_traces) {
            const trace = action_trace[1];
            trace['creator_action_ordinal'] = parent_index;
            trace_counter.trace_index++;
            trace['level'] = level;
            trace['action_ordinal'] = trace_counter.trace_index;
            arr.push(["action_trace_v0", omit(trace, "inline_traces")]);
            if (trace.inline_traces && trace.inline_traces.length > 0) {
                nextLevel.push({
                    traces: trace.inline_traces,
                    parent: trace_counter.trace_index
                });
            }
        }
        for (const data of nextLevel) {
            const appendedArray = await this.flattenInlineActions(data.traces, level + 1, trace_counter, data.parent);
            arr.push(...appendedArray);
        }
        return Promise.resolve(arr);
    }

}
