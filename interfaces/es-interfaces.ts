import {long} from "@elastic/elasticsearch/lib/api/types";

export interface getBlockTraceResponse {
    id: string;
    number: number;
    previous_id: string;
    status: string;
    timestamp: string;
    producer: string;
    transactions: any[];
}

export interface BlockIndexSource {
    producer: string;
    prev_id: string;
    block_id: string;
    block_num: number;
}

export interface LogsIndexSource {
    "@timestamp": string;
    missed_blocks: {
        producer: string;
        size: number;
    }
}

export interface DeltaIndexSource {
    code: string;
    table: string;
    scope: string;
}

export interface ActionIndexSource {
    trx_id: string;
    act: {
        account: string;
        name: string;
        authorization: {
            actor: string;
            permission: string;
        }[]
        data: any;
    }
    receipts: {
        receiver: string;
    }[];
    global_sequence: long;
    cpu_usage_us: number;
    net_usage_words: number;
}