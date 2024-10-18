import {HyperionActionAct} from "./hyperion-action";
import {AccountDelta} from "eosjs/dist/eosjs-api-interfaces";

export interface ActionTrace {
    signatures: string[];
    '@timestamp': string;
    act: HyperionActionAct
    block_num: number;
    block_id: string;
    global_sequence: number;
    producer: string;
    trx_id: string;
    account_ram_deltas?: any[];
    console?: string;
    elapsed?: any;
    context_free?: any;
    level?: number;
    except: any;
    receipt: any;
    creator_action_ordinal: number;
    action_ordinal: number;
    cpu_usage_us: number;
    net_usage_words: number;
    error_code: any;
    max_inline: number;
    inline_count: number;
    inline_filtered: boolean;
}

export interface TransactionTrace {
    id: string;
    status: number;
    cpu_usage_us: number;
    net_usage_words: number;
    elapsed: number;
    net_usage: number;
    scheduled: boolean;
    action_traces: ActionTrace[];
    account_ram_delta: AccountDelta | null;
    except: string | null;
    error_code: number | null;
    failed_dtrx_trace: any;
    partial: PartialTransaction | null;
    signatures: string[];
}

export interface PartialTransaction {
    expiration: string,
    ref_block_num: number,
    ref_block_prefix: number,
    max_net_usage_words: number,
    max_cpu_usage_ms: number,
    delay_sec: number,
    transaction_extensions: {
        type: number,
        data: string
    } | null,
    signatures: string[],
    context_free_data: string[]
}
