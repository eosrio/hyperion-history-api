import {ABI} from "@wharfkit/antelope";

export interface HyperionAbi {
    valid_until: number;
    block: number;
    account: string;
    abi: string;
    abi_hex: string;
    actions: string[];
    tables: string[];
}

export interface SavedAbi {
    abi: ABI.Def;
    valid_until: null;
    valid_from: null;
    actions?: string[];
}
