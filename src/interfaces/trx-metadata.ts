export interface TrxMetadata {
    signatures: string[];
    trx_id: string;
    block_num: number;
    block_id: string;
    producer: string;
    cpu_usage_us: number;
    net_usage_words: number;
    inline_count: number;
    filtered: boolean;
}
