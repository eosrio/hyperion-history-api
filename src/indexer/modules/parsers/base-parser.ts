import {Message} from "amqplib";

import {ConfigurationModule, Filters} from "../config.js";
import MainDSWorker from "../../workers/deserializer.js";
import DSPoolWorker from "../../workers/ds-pool.js";
import {TrxMetadata} from "../../../interfaces/trx-metadata.js";
import {ActionTrace} from "../../../interfaces/action-trace.js";
import {debugLog, hLog} from "../../helpers/common_functions.js";
import {HyperionActionAct} from "../../../interfaces/hyperion-action.js";
import {Action} from "@wharfkit/antelope";

export abstract class BaseParser {

    configModule: ConfigurationModule;
    filters: Filters;
    private readonly chain: string;
    flatten: boolean = false;
    private actionReinterpretMap: Map<string, (act: HyperionActionAct) => any>;

    protected constructor(cm: ConfigurationModule) {
        this.configModule = cm;
        this.filters = this.configModule.filters;
        this.chain = this.configModule.config.settings.chain;
        this.actionReinterpretMap = new Map();
        this.addCustomHandlers();
    }

    private anyFromCode(act: Action | HyperionActionAct) {
        return this.chain + '::' + act['account'] + '::*';
    }

    private anyFromName(act: Action | HyperionActionAct) {
        return this.chain + '::*::' + act['name'];
    }

    private codeActionPair(act: Action | HyperionActionAct) {
        return this.chain + '::' + act['account'] + '::' + act['name'];
    }

    protected checkBlacklist(act: Action | HyperionActionAct) {

        // test action blacklist for chain::code::*
        if (this.filters.action_blacklist.has(this.anyFromCode(act))) {
            return true;
        }

        // test action blacklist for chain::*::name
        if (this.filters.action_blacklist.has(this.anyFromName(act))) {
            return true;
        }

        // test action blacklist for chain::code::name
        return this.filters.action_blacklist.has(this.codeActionPair(act));
    }

    protected checkWhitelist(act: Action | HyperionActionAct) {

        // test action whitelist for chain::code::*
        if (this.filters.action_whitelist.has(this.anyFromCode(act))) {
            return true;
        }

        // test action whitelist for chain::*::name
        if (this.filters.action_whitelist.has(this.anyFromName(act))) {
            return true;
        }

        // test action whitelist for chain::code::name
        return this.filters.action_whitelist.has(this.codeActionPair(act));
    }

    protected extendFirstAction(
        worker: DSPoolWorker,
        action: ActionTrace,
        trx_data: TrxMetadata,
        full_trace: any,
        usageIncluded: { status: boolean }
    ) {
        action.cpu_usage_us = trx_data.cpu_usage_us;
        action.net_usage_words = trx_data.net_usage_words;
        action.signatures = trx_data.signatures;
        if (full_trace.action_traces.length > 1) {
            action.inline_count = trx_data.inline_count - 1;
            action.inline_filtered = trx_data.filtered;
            if (action.inline_filtered && worker.conf.indexer.max_inline) {
                action.max_inline = worker.conf.indexer.max_inline;
            }
        } else {
            action.inline_count = 0;
        }
        usageIncluded.status = true;
    }

    protected addCustomHandlers() {
        // simple assets
        // this.actionReinterpretMap.set('*::saecreate', (act) => {
        //     const _sb = this.createSerialBuffer(act.data);
        //     const result: any = {owner: "", assetid: null};
        //     result.owner = _sb.getName();
        //     result.assetid = _sb.getUint64AsNumber()
        //     return result;
        // });
        //
        // this.actionReinterpretMap.set('*::saetransfer', (act) => {
        //     const _sb = this.createSerialBuffer(act.data);
        //     const result: any = {from: "", to: "", assetids: [], memo: ""};
        //     result.from = _sb.getName();
        //     result.to = _sb.getName();
        //     const len = _sb.getVaruint32();
        //     for (let i = 0; i < len; i++) {
        //         result.assetids.push(_sb.getUint64AsNumber());
        //     }
        //     result.memo = _sb.getString();
        //     return result;
        // });
        //
        // this.actionReinterpretMap.set('*::saeclaim', (act) => {
        //     const _sb = this.createSerialBuffer(act.data);
        //     const result: any = {who: "", assetids: {}};
        //     result.who = _sb.getName();
        //     const len = _sb.getVaruint32();
        //     for (let i = 0; i < len; i++) {
        //         result.assetids[_sb.getUint64AsNumber()] = _sb.getName();
        //     }
        //     return result;
        // });
        //
        // this.actionReinterpretMap.set('*::saeburn', (act) => {
        //     const _sb = this.createSerialBuffer(act.data);
        //     const result: any = {who: "", assetids: [], memo: ""};
        //     result.who = _sb.getName();
        //     const len = _sb.getVaruint32();
        //     for (let i = 0; i < len; i++) {
        //         result.assetids.push(_sb.getUint64AsNumber());
        //     }
        //     result.memo = _sb.getString();
        //     return result;
        // });
    }

    async reinterpretActionData(act: HyperionActionAct) {
        if (this.actionReinterpretMap.has(`${act.account}::${act.name}`)) {
            // code and action
            const fn = this.actionReinterpretMap.get(`${act.account}::${act.name}`);
            if (fn) {
                return fn(act);
            }
        } else if (this.actionReinterpretMap.has(`*::${act.name}`)) {
            // wildcard action
            const fn = this.actionReinterpretMap.get(`*::${act.name}`);
            if (fn) {
                return fn(act);
            }
        }
        return;
    }

    async deserializeActionData(worker: DSPoolWorker, action: ActionTrace, trx_data) {
        let act = action.act;
        const original_act = Object.assign({}, act);
        let ds_act: any | null = null;
        let error_message: string = '';
        try {
            ds_act = await worker.common.deserializeActionAtBlockNative(worker, act, trx_data.block_num);
        } catch (e: any) {
            console.log(e);
            error_message = e.message;
        }

        // retry failed deserialization for custom ABI maps
        if (!ds_act) {
            try {
                ds_act = await this.reinterpretActionData(act);
            } catch (e) {
                hLog(`Failed to reinterpret action: ${act.account}::${act.name}`);
                hLog(act.data);
            }
        }

        // retry with the last abi before the given block_num
        if (!ds_act) {
            debugLog('DS Failed ->>', original_act);
            ds_act = await worker.common.deserializeActionAtBlockNative(worker, act, trx_data.block_num - 1);
            debugLog('Retry with previous ABI ->>', ds_act);
        }

        if (ds_act) {

            if (ds_act.account && ds_act.name && ds_act.authorization) {
                action.act.data = ds_act.data;
            }

            // save serialized data
            action.act.data = ds_act;

            // console.dir(action, {depth: Infinity, colors: true});

            try {
                worker.common.attachActionExtras(worker, action);
            } catch (e: any) {
                hLog('Failed to call attachActionExtras:', e.message);
                hLog(action?.act?.account, action?.act?.name, action?.act?.data);
            }
        } else {
            action['act'] = original_act;
            if (typeof action.act.data !== 'string') {
                action.act.data = Buffer.from(action.act.data).toString('hex');
            }
            action['ds_error'] = true;
            process.send?.({
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

    abstract parseAction(worker: DSPoolWorker, ts, action: ActionTrace, trx_data: TrxMetadata, _actDataArray, _processedTraces: ActionTrace[], full_trace, usageIncluded: {
        status: boolean
    }): Promise<boolean>

    abstract parseMessage(worker: MainDSWorker, messages: Message[]): Promise<void>

    abstract flattenInlineActions(action_traces: ActionTrace[], level?: number, trace_counter?: any, parent_index?: number): Promise<ActionTrace[]>
}
