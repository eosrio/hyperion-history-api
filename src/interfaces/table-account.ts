import {Document as MongoDoc} from "mongodb";

export interface IAccount extends MongoDoc {
    block_num: number;
    symbol: string;
    amount: number | string;
    code: string;
    scope: string;
}
