import {ABI} from "@wharfkit/antelope";

export interface HyperionAbi {
    valid_until: number | null;
    valid_from: number | null;
    block?: number;
    account?: string;
    abi: ABI.Def | string;
    abi_hex?: string;
    actions?: string[];
    tables?: string[];
}

export interface SavedAbi {
    abi: ABI.Def;
    valid_until: number | null;
    valid_from: number | null;
    actions?: string[];
}
