/**
 * @module JSON-RPC
 */
import { AbiProvider, AuthorityProvider, AuthorityProviderArgs, BinaryAbi } from './eosjs-api-interfaces';
import { GetAbiResult, GetBlockResult, GetCodeResult, GetInfoResult, GetRawCodeAndAbiResult, PushTransactionArgs } from "./eosjs-rpc-interfaces";
/** Make RPC calls */
export declare class JsonRpc implements AuthorityProvider, AbiProvider {
    endpoint: string;
    fetchBuiltin: (input?: Request | string, init?: RequestInit) => Promise<Response>;
    /**
     * @param args
     *    * `fetch`:
     *    * browsers: leave `null` or `undefined`
     *    * node: provide an implementation
     */
    constructor(endpoint: string, args?: {
        fetch?: (input?: string | Request, init?: RequestInit) => Promise<Response>;
    });
    /** Post `body` to `endpoint + path`. Throws detailed error information in `RpcError` when available. */
    fetch(path: string, body: any): Promise<any>;
    /** Raw call to `/v1/chain/get_abi` */
    get_abi(accountName: string): Promise<GetAbiResult>;
    /** Raw call to `/v1/chain/get_account` */
    get_account(accountName: string): Promise<any>;
    /** Raw call to `/v1/chain/get_block_header_state` */
    get_block_header_state(blockNumOrId: number | string): Promise<any>;
    /** Raw call to `/v1/chain/get_block` */
    get_block(blockNumOrId: number | string): Promise<GetBlockResult>;
    /** Raw call to `/v1/chain/get_code` */
    get_code(accountName: string): Promise<GetCodeResult>;
    /** Raw call to `/v1/chain/get_currency_balance` */
    get_currency_balance(code: string, account: string, symbol?: string): Promise<any>;
    /** Raw call to `/v1/chain/get_currency_stats` */
    get_currency_stats(code: string, symbol: string): Promise<any>;
    /** Raw call to `/v1/chain/get_info` */
    get_info(): Promise<GetInfoResult>;
    /** Raw call to `/v1/chain/get_producer_schedule` */
    get_producer_schedule(): Promise<any>;
    /** Raw call to `/v1/chain/get_producers` */
    get_producers(json?: boolean, lowerBound?: string, limit?: number): Promise<any>;
    /** Raw call to `/v1/chain/get_raw_code_and_abi` */
    get_raw_code_and_abi(accountName: string): Promise<GetRawCodeAndAbiResult>;
    /** calls `/v1/chain/get_raw_code_and_abi` and pulls out unneeded raw wasm code */
    getRawAbi(accountName: string): Promise<BinaryAbi>;
    /** Raw call to `/v1/chain/get_table_rows` */
    get_table_rows({ json, code, scope, table, table_key, lower_bound, upper_bound, index_position, key_type, limit, reverse, show_payer, }: any): Promise<any>;
    /** Raw call to `/v1/chain/get_table_by_scope` */
    get_table_by_scope({ code, table, lower_bound, upper_bound, limit, }: any): Promise<any>;
    /** Get subset of `availableKeys` needed to meet authorities in `transaction`. Implements `AuthorityProvider` */
    getRequiredKeys(args: AuthorityProviderArgs): Promise<string[]>;
    /** Push a serialized transaction */
    push_transaction({ signatures, serializedTransaction }: PushTransactionArgs): Promise<any>;
    /** Raw call to `/v1/db_size/get` */
    db_size_get(): Promise<any>;
    /** Raw call to `/v1/history/get_actions` */
    history_get_actions(accountName: string, pos?: number, offset?: number): Promise<any>;
    /** Raw call to `/v1/history/get_transaction` */
    history_get_transaction(id: string, blockNumHint?: number): Promise<any>;
    /** Raw call to `/v1/history/get_key_accounts` */
    history_get_key_accounts(publicKey: string): Promise<any>;
    /** Raw call to `/v1/history/get_controlled_accounts` */
    history_get_controlled_accounts(controllingAccount: string): Promise<any>;
}
