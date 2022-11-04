import {BaseParser, timedFunction} from "./base-parser.js";
import MainDSWorker from "../../workers/deserializer.js";
import {Message} from "amqplib";
import DSPoolWorker from "../../workers/ds-pool.js";
import {TrxMetadata} from "../../interfaces/trx-metadata.js";
import {ActionTrace} from "../../interfaces/action-trace.js";
import {deserialize, hLog} from "../../helpers/common_functions.js";
import {appendFileSync} from "node:fs";

export default class HyperionParser extends BaseParser {

    flatten = false;

    public async parseAction(worker: DSPoolWorker, ts, action: ActionTrace, trx_data: TrxMetadata, _actDataArray, _processedTraces: ActionTrace[], full_trace, usageIncluded): Promise<boolean> {
        // check filters
        if (this.checkBlacklist(action.act)) return false;
        if (this.filters.action_whitelist.size > 0) {
            if (!this.checkWhitelist(action.act)) return false;
        }

        await this.deserializeActionData(worker, action, trx_data);

        action["@timestamp"] = ts;
        action.block_num = trx_data.block_num;
        action.block_id = trx_data.block_id;
        action.producer = trx_data.producer;
        action.trx_id = trx_data.trx_id;

        if (action.account_ram_deltas && action.account_ram_deltas.length === 0) {
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
                this.extendFirstAction(worker, action, trx_data, full_trace, usageIncluded);
            }

            _processedTraces.push(action);
        } else {
            hLog(action);
        }

        return true;
    }

    public async parseMessage(worker: MainDSWorker, messages: Message[]): Promise<void> {
        const dsProfiling = worker.conf.settings.ds_profiling;
        for (const message of messages) {

            // profile deserialization
            const ds_times: any = {
                size: message.content.length,
                eosjs: {
                    result: undefined,
                    signed_block: undefined,
                    transaction_trace: undefined,
                    table_delta: undefined
                },
                abieos: {
                    result: undefined,
                    signed_block: undefined,
                    transaction_trace: undefined,
                    table_delta: undefined
                }
            };

            let allowProcessing = true;
            let ds_msg;

            // deserialize result using abieos
            // ds_times.abieos.result = timedFunction(dsProfiling,() => {
            //     ds_msg = worker.deserializeNative('result', message.content);
            // });

            // deserialize result using eosjs (faster)
            ds_times.eosjs.result = timedFunction(dsProfiling, () => {
                ds_msg = deserialize('result', message.content, this.txEnc, this.txDec, worker.types);
            });

            if (!ds_msg) {
                if (worker.ch_ready) {
                    worker.ch.nack(message);
                    throw new Error('failed to deserialize datatype=result');
                }
            }

            const res = ds_msg[1];

            let block: any = null;
            if (res.block && res.block.length) {

                if (typeof res.block === 'object' && res.block.length === 2) {
                    // already deserialized
                    block = res.block[1];
                } else {
                    try {
                        // deserialize signed_block using abieos (faster)
                        ds_times.abieos.signed_block = timedFunction(dsProfiling, () => {
                            block = worker.deserializeNative('signed_block_variant', res.block)[1];
                        });
                    } catch (e: any) {
                        hLog('signed_block_variant deserialization failed with abieos!');
                    }
                    if (!block) {
                        try {
                            // deserialize signed_block using eosjs
                            ds_times.eosjs.signed_block = timedFunction(dsProfiling, () => {
                                block = deserialize('signed_block_variant', res.block, this.txEnc, this.txDec, worker.types);
                            });
                        } catch (e: any) {
                            hLog('signed_block_variant deserialization failed with eosjs!');
                        }
                    }
                }

                if (block === null) {
                    console.log(res);
                    process.exit(1);
                }

                // verify for whitelisted contracts (root actions only)
                if (worker.conf.whitelists.root_only) {
                    try {

                        // get time reference for profiling
                        if (worker.conf.settings.ds_profiling) ds_times['packed_trx'] = process.hrtime.bigint();

                        if (worker.conf.whitelists &&
                            (worker.conf.whitelists.actions.length > 0 ||
                                worker.conf.whitelists.deltas.length > 0)) {

                            allowProcessing = false;

                            for (const transaction of block.transactions) {
                                if (transaction.status === 0 && transaction.trx[1] && transaction.trx[1].packed_trx) {
                                    const unpacked_trx = worker.api.deserializeTransaction(Buffer.from(transaction.trx[1].packed_trx, 'hex'));
                                    for (const act of unpacked_trx.actions) {
                                        if (this.checkWhitelist(act)) {
                                            allowProcessing = true;
                                            break;
                                        }
                                    }
                                    if (allowProcessing) break;
                                }
                            }
                        }

                        // store time diff
                        if (worker.conf.settings.ds_profiling) ds_times['packed_trx'] = Number(process.hrtime.bigint() - ds_times['packed_trx']) / 1000;

                    } catch (e: any) {
                        console.log(e);
                        allowProcessing = true;
                    }
                }
            }

            // unpack traces
            let traces = null;
            if (allowProcessing && res.traces && res.traces.length) {

                // deserialize transaction_trace using abieos (faster)
                try {
                    ds_times.abieos.transaction_trace = timedFunction(dsProfiling, () => {
                        traces = worker.deserializeNative('transaction_trace[]', res.traces);
                    });
                } catch (e: any) {
                    hLog('transaction_trace[] deserialization failed with abieos!');
                }

                // deserialize transaction_trace using eosjs
                if (!traces) {
                    try {
                        ds_times.eosjs.transaction_trace = timedFunction(dsProfiling, () => {
                            traces = deserialize('transaction_trace[]', res.traces, this.txEnc, this.txDec, worker.types);
                        });
                    } catch (e: any) {
                        hLog('transaction_trace[] deserialization failed with eosjs!');
                    }
                }


                if (!traces) {
                    hLog(`[WARNING] transaction_trace[] deserialization failed on block ${res['this_block']['block_num']}`);
                }
            }

            // unpack deltas
            let deltas = null;
            if (allowProcessing && res.deltas && res.deltas.length) {

                // deserialize table_delta using abieos
                try {
                    ds_times.abieos.table_delta = timedFunction(dsProfiling, () => {
                        deltas = worker.deserializeNative('table_delta[]', res.deltas);
                    });
                } catch (e: any) {
                    hLog('table_delta[] deserialization failed with abieos!');
                }

                // deserialize table_delta using eosjs
                if (!deltas) {
                    try {
                        ds_times.eosjs.table_delta = timedFunction(dsProfiling, () => {
                            deltas = deserialize('table_delta[]', res.deltas, this.txEnc, this.txDec, worker.types);
                        });
                    } catch (e: any) {
                        hLog('table_delta[] deserialization failed with eosjs!');
                    }
                }

                if (!deltas) {
                    hLog(`[WARNING] table_delta[] deserialization failed on block ${res['this_block']['block_num']}`);
                }
            }

            if (worker.conf.settings.ds_profiling) {
                hLog(ds_times);
                const line: any[] = [ds_times.size];
                line.push(...[ds_times.eosjs.result, ds_times.eosjs.signed_block, ds_times.eosjs.transaction_trace, ds_times.eosjs.table_delta]);
                line.push(...[ds_times.abieos.result, ds_times.abieos.signed_block, ds_times.abieos.transaction_trace, ds_times.abieos.table_delta]);
                appendFileSync('ds_profiling.csv', line.join(',') + "\n");
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
                    process.send?.(evPayload);
                } else {
                    hLog(`ERROR: Block data not found for #${res['this_block']['block_num']}`);
                }
                if (worker.ch_ready) {
                    worker.ch.ack(message);
                }
            } catch (e: any) {
                console.log(e);
                if (worker.ch_ready) {
                    worker.ch.nack(message);
                }
                process.exit(1);
            }
        }
    }

    async flattenInlineActions(action_traces: any[]): Promise<any> {
        hLog(`Calling undefined flatten operation!`);
        return Promise.resolve(undefined);
    }

}