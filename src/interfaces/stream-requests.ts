export interface RequestFilter {
    field: string;
    value: string | number | boolean;
    operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'starts_with' | 'ends_with';
    asset?: string;
}

export type StreamTypeMap = {
    action: {
        request: StreamActionsRequest;
        reqType: "action_request";
        endReqType: "action_history_end";
    };
    delta: {
        request: StreamDeltasRequest;
        reqType: "delta_request";
        endReqType: "delta_history_end";
    };
};

export type StreamRequest = StreamTypeMap[keyof StreamTypeMap]["request"];
export type RequestEvents = StreamTypeMap[keyof StreamTypeMap]["reqType"];
export type StreamEvents = RequestEvents | 'history_end';

export interface StreamActionsRequest {
    contract: string;
    account: string;
    action: string;
    start_from: number | string;
    read_until: number | string;
    ignore_live?: boolean;
    filter_op?: 'and' | 'or';
    filters?: RequestFilter[];
    // Request a history replay from the last received block
    replayOnReconnect?: boolean;
}

export interface StreamDeltasRequest {
    code: string;
    table: string;
    scope: string;
    payer: string;
    start_from: number | string;
    read_until: number | string;
    ignore_live?: boolean;
    filter_op?: 'and' | 'or';
    filters?: RequestFilter[];
    // Request a history replay from the last received block
    replayOnReconnect?: boolean;
}

export interface StreamMessage<T> {
    request: T;
    reqUUID: string;
    client_socket: string;
}

