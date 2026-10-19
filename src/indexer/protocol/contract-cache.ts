import type {ProtocolContractCodec} from '@eosrio/hyperion-sdk/protocol';

/** Internal compatibility facade for the existing worker caches; not an SDK/native API. */
export interface ContractDecoder {
    loadAbi(contract: string, abi: string | object): boolean;
    loadAbiHex(contract: string, hex: string): boolean;
    deleteContract(contract: string): boolean;
    getTypeForAction(contract: string, action: string): string;
    getTypeForTable(contract: string, table: string): string;
    binToJson(contract: string, type: string, bytes: Uint8Array): any;
    hexToJson(contract: string, type: string, hex: string): any;
}

export function protocolBytes(input: unknown): Uint8Array {
    if (input instanceof Uint8Array) return input;
    if (typeof input === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(input)) return Buffer.from(input, 'hex');
    if (input && typeof input === 'object' && 'array' in input) return protocolBytes(input.array);
    throw new Error('Invalid protocol byte payload');
}

export function protocolNumber(input: any): number {
    const value = typeof input?.toNumber === 'function' ? input.toNumber() : Number(input);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid protocol integer');
    return value;
}

/** Extension codecs hold only portable ABI metadata, independently for each worker. */
export function createContractDecoder(codec: ProtocolContractCodec): ContractDecoder {
    const abis = new Map<string, any>();
    const required = (contract: string) => {
        if (!abis.has(contract)) throw new Error(`No selected ABI for ${contract}`);
        return abis.get(contract);
    };
    return {
        loadAbi(contract, input) {
            abis.delete(contract);
            // Validate using the selected dialect, including complete trailing metadata.
            const abi = typeof input === 'string' ? JSON.parse(input) : input;
            abis.set(contract, codec.decodeAbi(codec.encodeAbi(abi)));
            return true;
        },
        loadAbiHex(contract, hex) { abis.delete(contract); abis.set(contract, codec.decodeAbi(protocolBytes(hex))); return true; },
        deleteContract(contract) { return abis.delete(contract); },
        getTypeForAction(contract, name) { return required(contract).actions?.find(entry => String(entry.name) === name)?.type ?? ''; },
        getTypeForTable(contract, name) { return required(contract).tables?.find(entry => String(entry.name) === name)?.type ?? ''; },
        binToJson(contract, type, bytes) { return codec.decodeValue(required(contract), type, bytes); },
        hexToJson(contract, type, hex) { return codec.decodeValue(required(contract), type, protocolBytes(hex)); },
    };
}
