import {Serialize} from "enf-eosjs";

export interface HyperionActionAct {
    account: string;
    name: string;
    authorization: Serialize.Authorization[];
    data: any;
}

export interface HyperionAction {
    action_ordinal: number;
    creator_action_ordinal: number;
    receipt: any[];
    notified: string[];
    receiver: string;
    act: Serialize.Action;
    context_free: boolean;
    elapsed: string;
    console: string;
    account_ram_deltas: any[];
    except: any;
    error_code: any;
    block_num: number;
    trx_id: string;
    '@timestamp': string;

    [k: string]: any;
}
