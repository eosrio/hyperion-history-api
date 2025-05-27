import {Worker} from "cluster";

export interface HyperionWorkerDef {
    worker_id?: number;
    failures?: number;
    worker_role?: string;
    worker_queue?: string;
    queue?: string;
    local_id?: number;
    worker_last_processed_block?: number;
    ws_router?: string;
    live_mode?: string;
    type?: string;
    wref?: Worker;
    distribution?: any;
    first_block?: number;
    last_block?: number;
    validated_ship_servers?: string;
}

export interface RevBlock {
    num: number;
    id: string;
    tx: string[];
}

export interface WorkerMessage {
    root_act?: any;
    signatures?: any;
    trx_id?: string;
    total_hits?: number;
    deltas?: number;
    actions?: number;
    size?: number;
    id?: string;
    worker_id?: any;
    trx_ids?: string[];
    live_mode?: string;
    block_id?: string;
    event: string;
    live?: string;
    target?: string;
    data?: any;
    block_num?: number;
    block_ts?: string;
    mId?: string;
}

export type WorkerMessageHandler = (worker: Worker, msg: WorkerMessage) => Promise<void> | void;