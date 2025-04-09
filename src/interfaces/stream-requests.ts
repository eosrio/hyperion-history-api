export interface RequestFilter {
    field: string;
    value: string | number | boolean;
    operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'starts_with' | 'ends_with';
}

export interface StreamActionsRequest {
    contract: string;
    account: string;
    action: string;
    start_from: number | string;
    read_until: number | string;
    filter_op?: 'and' | 'or';
    filters?: RequestFilter[];
}

export interface StreamDeltasRequest {
    code: string;
    table: string;
    scope: string;
    payer: string;
    start_from: number | string;
    read_until: number | string;
    filter_op?: 'and' | 'or';
    filters?: RequestFilter[];
}

export interface StreamMessage<T> {
    request: T;
    reqUUID: string;
    client_socket: string;
}

