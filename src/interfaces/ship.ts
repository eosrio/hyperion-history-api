export interface ShipBlockInfo {
    block_num: number;
    block_id: string;
}

export interface ShipGetBlocksPayload {
    head: ShipBlockInfo;
    last_irreversible: ShipBlockInfo;
    this_block: ShipBlockInfo | null;
    prev_block: ShipBlockInfo | null;
    block: Uint8Array | null;
    traces: Uint8Array | null;
    deltas: Uint8Array | null;
}

export interface StageOneTaskPayload {
    num: number;
    content: Buffer;
}
