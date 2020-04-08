import {HyperionAction} from "./hyperion-action";

export interface ActionTrace {
    '@timestamp': string;
    act: HyperionAction
    block_num: number;
    global_sequence: number;
    producer: string;
    trx_id: string;
    account_ram_deltas?: any[];
    console?: string;
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
