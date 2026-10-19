import { BaseParser } from "./base-parser.js";
import MainDSWorker from "../../workers/deserializer.js";
import { Message } from "amqplib";
import DSPoolWorker from "../../workers/ds-pool.js";
import { TrxMetadata } from "../../../interfaces/trx-metadata.js";
import { ActionTrace } from "../../../interfaces/action-trace.js";
import { hLog } from "../../helpers/common_functions.js";
import { PackedTransaction, Serializer } from "@wharfkit/antelope";
import { GetBlocksResultV0 } from "../../workers/state-reader.js";
import {protocolBytes} from "../../protocol/contract-cache.js";

export default class HyperionParser extends BaseParser {

    flatten = false;

    public async parseAction(
        worker: DSPoolWorker,
        ts: string,
        action: ActionTrace,
        trx_data: TrxMetadata,
        _actDataArray,
        _processedTraces: ActionTrace[],
        full_trace,
        usageIncluded
    ): Promise<boolean> {

        const stopParseAction = worker.profiler.start('parse_action');
        try {

        // check filters
        if (this.checkBlacklist(action.act)) {
            return false;
        }
        if (this.filters.action_whitelist.size > 0) {
            if (!this.checkWhitelist(action.act)) {
                return false;
            }
        }

        await this.deserializeActionData(worker, action, trx_data);

        action["@timestamp"] = ts;
        action.block_num = trx_data.block_num;
        action.block_id = trx_data.block_id;
        action.producer = trx_data.producer;
        action.trx_id = trx_data.trx_id;

        if (action.account_ram_deltas) {
            action.account_ram_deltas = action.account_ram_deltas.filter(value => value.delta !== '0')
        }

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
            if (action.error_code === null) {
                delete action.error_code;
            }
            // add usage data to the first action on the transaction
            if (!usageIncluded.status) {
                this.extendFirstAction(worker, action, trx_data, full_trace, usageIncluded);
                // ignore eosio.null::nonce
                if (action.act.account === this.configModule.config.settings.eosio_alias + '.null' && action.act.name === 'nonce') {
                    usageIncluded.status = false;
                }
            }
            _processedTraces.push(action);
        } else {
            hLog(action);
        }

        return true;
        } finally {
            stopParseAction();
        }
    }

    public async parseMessage(worker: MainDSWorker, messages: Message[]): Promise<void> {
        for (const message of messages) {

            let allowProcessing = true;

            const stopResult = worker.profiler.start('deserialize_result');
            const ds_msg = worker.decodeShipResult(message.content) as [string, GetBlocksResultV0];
            stopResult();

            if (!ds_msg) {
                if (worker.ch && worker.ch_ready) {
                    worker.ch.nack(message);
                    throw new Error('failed to deserialize datatype=result');
                }
            }

            const res = ds_msg[1];
            let block: any = null;
            let traces = [];
            let deltas: any[] = [];

            // Observe full source inputs before root-only, whitelist or max-inline filtering.
            // Storage failure escapes without reaching the source acknowledgment below.
            const observation = worker.usesExtensionProtocol
                ? await worker.prepareProtocolAbiObservations(res) : undefined;

            if (res.block && res.block.length) {
                const stopBlock = worker.profiler.start('deserialize_block');
                block = worker.deserializeNative('signed_block', protocolBytes(res.block));
                stopBlock();
                if (block === null) {
                    hLog('incompatible block');
                    process.exit(1);
                }
                // verify for whitelisted contracts (root actions only)
                if (worker.conf.whitelists.root_only) {
                    try {
                        if (worker.conf.whitelists && (worker.conf.whitelists.actions.length > 0 || worker.conf.whitelists.deltas.length > 0)) {
                            allowProcessing = false;
                            for (const transaction of block.transactions) {
                                const packed = Array.isArray(transaction.trx) ? transaction.trx[1] : transaction.trx;
                                const included = transaction.status === 0
                                    || (worker.usesExtensionProtocol && transaction.status === undefined && !Array.isArray(transaction.trx));
                                if (included && packed?.packed_trx) {
                                    const unpacked_trx = worker.decodePackedTransaction(packed);
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
                    } catch (e) {
                        console.log(e);
                        allowProcessing = true;
                    }
                }
            }

            if (allowProcessing && res.traces && res.traces.length) {
                const stopTraces = worker.profiler.start('deserialize_traces');
                traces = observation?.traces ?? worker.deserializeNative('transaction_trace[]', protocolBytes(res.traces));
                stopTraces();
                if (!traces) {
                    hLog(`[WARNING] transaction_trace[] deserialization failed on block ${res['this_block']['block_num']}`);
                }
            }

            if (allowProcessing && res.deltas && res.deltas.length) {
                const stopDeltas = worker.profiler.start('deserialize_deltas');
                deltas = observation?.deltas ?? worker.decodeShipValue('table_delta[]', res.deltas);
                stopDeltas();
                if (!deltas) {
                    hLog(`[WARNING] table_delta[] deserialization failed on block ${res['this_block']['block_num']}`);
                }
            }

            let result;
            try {
                const stopProcess = worker.profiler.start('process_block');
                result = await worker.processBlock(res, block, traces, deltas);
                stopProcess();
                if (result) {
                    const evPayload = {
                        event: 'consumed_block',
                        block_num: result['block_num'],
                        block_id: result['block_id'],
                        block_ts: result['block_ts'],
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
                if (worker.ch && worker.ch_ready) {
                    worker.ch.ack(message);
                }
            } catch (e) {
                console.log(e);
                if (worker.ch && worker.ch_ready) {
                    worker.ch.nack(message);
                }
                process.exit(1);
            }
        }
    }

    async flattenInlineActions(action_traces: any[]): Promise<any[]> {
        hLog(`Calling undefined flatten operation!`);
        return Promise.resolve<any>(undefined);
    }

}
