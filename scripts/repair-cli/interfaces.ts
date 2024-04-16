export interface HyperionBlock {
    "@timestamp": string,
    "block_num": number,
    "block_id": string,
    "producer": string,
    "new_producers"?: any,
    "schedule_version": number,
    "cpu_usage": number,
    "net_usage": number,
    "prev_id": string
    transactions: any[]
}
