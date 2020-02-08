import {HyperionAction} from "./hyperion-action";

export interface ActionTrace {
    act: HyperionAction
    '@timestamp': string;
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
}
