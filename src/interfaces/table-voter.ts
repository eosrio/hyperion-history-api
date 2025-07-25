import {Document as MongoDoc} from "mongodb";

export interface IVoter extends MongoDoc {
    block_num: number,
    is_proxy: boolean,
    last_vote_weight: string,
    primary_key: string,
    producers: string[],
    proxied_vote_weight: string,
    proxy: string,
    staked: number,
    voter: string,
}
