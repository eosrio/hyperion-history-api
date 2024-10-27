export interface HyperionAbi {
    valid_until: number;
    block: number;
    account: string;
    abi: string;
    abi_hex: string;
    actions: string[];
    tables: string[];
}