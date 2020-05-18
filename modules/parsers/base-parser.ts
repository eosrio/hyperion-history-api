import {ConfigurationModule, Filters} from "../config";
import MainDSWorker from "../../workers/deserializer";
import {Message} from "amqplib";
import DSPoolWorker from "../../workers/ds-pool";
import {TrxMetadata} from "../../interfaces/trx-metadata";
import {ActionTrace} from "../../interfaces/action-trace";
import {hLog} from "../../helpers/common_functions";

export abstract class BaseParser {

    txDec = new TextDecoder();
    txEnc = new TextEncoder();
    configModule: ConfigurationModule;
    filters: Filters;
    private readonly chain: string;
    flatten: boolean = false;

    protected constructor(cm: ConfigurationModule) {
        this.configModule = cm;
        this.filters = this.configModule.filters;
        this.chain = this.configModule.config.settings.chain;
    }

    private anyFromCode(act) {
        return this.chain + '::' + act['account'] + '::*'
    }

    private codeActionPair(act) {
        return this.chain + '::' + act['account'] + '::' + act['name'];
    }

    protected checkBlacklist(act) {
        if (this.filters.action_blacklist
            .has(this.anyFromCode(act))) {
            return true;
        } else return this.filters.action_blacklist
            .has(this.codeActionPair(act));
    }

    protected checkWhitelist(act) {
        if (this.filters.action_whitelist.has(this.anyFromCode(act))) {
            return true;
        } else return this.filters.action_whitelist.has(this.codeActionPair(act));
    }

    protected extendFirstAction(worker: DSPoolWorker, action: ActionTrace, trx_data: TrxMetadata, full_trace: any, usageIncluded) {
        action.cpu_usage_us = trx_data.cpu_usage_us;
        action.net_usage_words = trx_data.net_usage_words;
        if (full_trace.action_traces.length > 1) {
            action.inline_count = trx_data.inline_count - 1;
            action.inline_filtered = trx_data.filtered;
            if (action.inline_filtered) {
                action.max_inline = worker.conf.indexer.max_inline;
            }
        } else {
            action.inline_count = 0;
        }
        usageIncluded.status = true;
    }

    async deserializeActionData(worker: DSPoolWorker, action: ActionTrace, trx_data) {
        let act = action.act;
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
            try {
                worker.common.attachActionExtras(worker, action);
            } catch (e) {
                hLog(e);
            }
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
    }

    abstract async parseAction(worker: DSPoolWorker, ts, action: ActionTrace, trx_data: TrxMetadata, _actDataArray, _processedTraces: ActionTrace[], full_trace, usageIncluded: { status: boolean }): Promise<boolean>

    abstract async parseMessage(worker: MainDSWorker, messages: Message[]): Promise<void>

    abstract async flattenInlineActions(action_traces: any[], level?: number, trace_counter?: any, parent_index?: number): Promise<any[]>
}
