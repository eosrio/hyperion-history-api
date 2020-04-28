export interface TrxMetadata {
    trx_id: string;
    block_num: number;
    producer: string;
    cpu_usage_us: number;
    net_usage_words: number;
    inline_count: number;
    filtered: boolean;
}
