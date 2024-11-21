interface ProducerKey {
    producer_name: string;
    block_signing_key: string;
}

export interface ProducerSchedule {
    version: number;
    producers: ProducerKey[];
}

interface Extension {
    type: number;
    data: string;
}

interface TransactionReceipt {
    status: number;
    cpu_usage_us: number;
    net_usage_words: number;
    trx: any;
}

export interface HyperionSignedBlock {
    timestamp: string,
    producer: string,
    confirmed: number,
    previous: string,
    transaction_mroot: string,
    action_mroot: string,
    schedule_version: number,
    new_producers?: ProducerSchedule,
    header_extensions: Extension[],
    producer_signature: string,
    transactions: TransactionReceipt[],
    block_extensions: Extension[],
}
