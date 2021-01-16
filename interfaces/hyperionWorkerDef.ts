import * as cluster from "cluster";

export interface HyperionWorkerDef {
    worker_id?: number;
    worker_role?: string;
    worker_queue?: string;
    queue?: string;
    local_id?: number;
    worker_last_processed_block?: number;
    ws_router?: string;
    live_mode?: string;
    type?: string;
    wref?: cluster.Worker;
    distribution?: any;
    first_block?: number;
    last_block?: number;
}
