/**
 * @module API
 */
import { AbiProvider, AuthorityProvider, BinaryAbi, CachedAbi, SignatureProvider } from './eosjs-api-interfaces';
import { JsonRpc } from './eosjs-jsonrpc';
import { Abi, PushTransactionArgs } from './eosjs-rpc-interfaces';
import * as ser from './eosjs-serialize';
export declare class Api {
    /** Issues RPC calls */
    rpc: JsonRpc;
    /** Get subset of `availableKeys` needed to meet authorities in a `transaction` */
    authorityProvider: AuthorityProvider;
    /** Supplies ABIs in raw form (binary) */
    abiProvider: AbiProvider;
    /** Signs transactions */
    signatureProvider: SignatureProvider;
    /** Identifies chain */
    chainId: string;
    textEncoder: TextEncoder;
    textDecoder: TextDecoder;
    /** Converts abi files between binary and structured form (`abi.abi.json`) */
    abiTypes: Map<string, ser.Type>;
    /** Converts transactions between binary and structured form (`transaction.abi.json`) */
    transactionTypes: Map<string, ser.Type>;
    /** Holds information needed to serialize contract actions */
    contracts: Map<string, ser.Contract>;
    /** Fetched abis */
    cachedAbis: Map<string, CachedAbi>;
    /**
     * @param args
     *    * `rpc`: Issues RPC calls
     *    * `authorityProvider`: Get public keys needed to meet authorities in a transaction
     *    * `abiProvider`: Supplies ABIs in raw form (binary)
     *    * `signatureProvider`: Signs transactions
     *    * `chainId`: Identifies chain
     *    * `textEncoder`: `TextEncoder` instance to use. Pass in `null` if running in a browser
     *    * `textDecoder`: `TextDecoder` instance to use. Pass in `null` if running in a browser
     */
    constructor(args: {
        rpc: JsonRpc;
        authorityProvider?: AuthorityProvider;
        abiProvider?: AbiProvider;
        signatureProvider: SignatureProvider;
        chainId?: string;
        textEncoder?: TextEncoder;
        textDecoder?: TextDecoder;
    });
    /** Decodes an abi as Uint8Array into json. */
    rawAbiToJson(rawAbi: Uint8Array): Abi;
    /** Get abi in both binary and structured forms. Fetch when needed. */
    getCachedAbi(accountName: string, reload?: boolean): Promise<CachedAbi>;
    /** Get abi in structured form. Fetch when needed. */
    getAbi(accountName: string, reload?: boolean): Promise<Abi>;
    /** Get abis needed by a transaction */
    getTransactionAbis(transaction: any, reload?: boolean): Promise<BinaryAbi[]>;
    /** Get data needed to serialize actions in a contract */
    getContract(accountName: string, reload?: boolean): Promise<ser.Contract>;
    /** Convert `value` to binary form. `type` must be a built-in abi type or in `transaction.abi.json`. */
    serialize(buffer: ser.SerialBuffer, type: string, value: any): void;
    /** Convert data in `buffer` to structured form. `type` must be a built-in abi type or in `transaction.abi.json`. */
    deserialize(buffer: ser.SerialBuffer, type: string): any;
    /** Convert a transaction to binary */
    serializeTransaction(transaction: any): Uint8Array;
    /** Convert a transaction from binary. Leaves actions in hex. */
    deserializeTransaction(transaction: Uint8Array): any;
    /** Convert actions to hex */
    serializeActions(actions: ser.Action[]): Promise<ser.SerializedAction[]>;
    /** Convert actions from hex */
    deserializeActions(actions: ser.Action[]): Promise<ser.Action[]>;
    /** Convert a transaction from binary. Also deserializes actions. */
    deserializeTransactionWithActions(transaction: Uint8Array | string): Promise<any>;
    /**
     * Create and optionally broadcast a transaction.
     *
     * Named Parameters:
     *    * `broadcast`: broadcast this transaction?
     *    * `sign`: sign this transaction?
     *    * If both `blocksBehind` and `expireSeconds` are present,
     *      then fetch the block which is `blocksBehind` behind head block,
     *      use it as a reference for TAPoS, and expire the transaction `expireSeconds` after that block's time.
     * @returns node response if `broadcast`, `{signatures, serializedTransaction}` if `!broadcast`
     */
    transact(transaction: any, { broadcast, sign, blocksBehind, expireSeconds }?: {
        broadcast?: boolean;
        sign?: boolean;
        blocksBehind?: number;
        expireSeconds?: number;
    }): Promise<any>;
    /** Broadcast a signed transaction */
    pushSignedTransaction({ signatures, serializedTransaction }: PushTransactionArgs): Promise<any>;
    private hasRequiredTaposFields;
}
