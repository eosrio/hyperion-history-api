import { Document as MongoDoc } from "mongodb";
export interface IPermission extends MongoDoc {
    block_num: number;
    last_updated: string;
    account: string;
    perm_name: string;
    parent: string;
    required_auth: {
        threshold: number;
        keys: Array<{
            key: string;
            weight: number;
        }>;
        accounts: Array<{
            permission: {
                actor: string;
                permission: string;
            };
            weight: number;
        }>;
        waits: Array<{
            wait_sec: number;
            weight: number;
        }>;
    },
    linked_actions: Array<{
        account: string;
        action: string;
    }>
}