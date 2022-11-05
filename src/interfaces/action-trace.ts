import {HyperionActionAct} from "./hyperion-action.js";

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
    ds_error?: boolean;
}
