export interface HyperionActionAct {
    account: string;
    name: string;
    authorization: any;
    data: any;
    hex_data: string | undefined;
    hex_encoder: string | undefined;
}

export interface HyperionAction {
    action_ordinal: number;
    creator_action_ordinal: number;
    receipt: any[];
    receiver: string;
    act: HyperionActionAct;
    context_free: boolean;
    elapsed: string;
    console: string;
    account_ram_deltas: any[];
    except: any;
    error_code: any;
}
