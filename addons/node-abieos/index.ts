const abieos = require('./abieos.node');

interface AbiEosAddon {
    string_to_name(name_string: string): BigInteger;

    json_to_hex(contract_name: string, type: string, json: string, abi: string): string;

    hex_to_json(contract_name: string, type: string, hex: string): string;

    bin_to_json(contract_name: string, type: string, buffer: Buffer): string;

    load_abi(contract_name: string, abi: string): boolean;

    load_abi_hex(contract_name: string, abihex: string): boolean;

    get_type_for_action(contract_name: string, action_name: string): string;

    get_type_for_table(contract_name: string, table_name: string): string;

    delete_contract(contract_name: string): boolean;
}

export const AbiEOS: AbiEosAddon = abieos;
