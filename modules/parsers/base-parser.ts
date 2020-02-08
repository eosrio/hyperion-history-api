import {ConfigurationModule, Filters} from "../config";
import MainDSWorker from "../../workers/deserializer";
import {Message} from "amqplib";
import DSPoolWorker from "../../workers/ds-pool";
import {TrxMetadata} from "../../interfaces/trx-metadata";
import {ActionTrace} from "../../interfaces/action-trace";

export abstract class BaseParser {

    txDec = new TextDecoder();
    txEnc = new TextEncoder();
    configModule: ConfigurationModule;
    filters: Filters;
    private readonly chain: string;

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

    abstract async parseAction(worker: DSPoolWorker, ts, action: ActionTrace, trx_data: TrxMetadata, _actDataArray, _processedTraces: ActionTrace[], full_trace): Promise<boolean>

    abstract async parseMessage(worker: MainDSWorker, messages: Message[]): Promise<void>
}
