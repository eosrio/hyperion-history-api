import {checkFilter, hLog} from '../helpers/common_functions.js';
import {Server, Socket} from 'socket.io';
import {createAdapter} from 'socket.io-redis';
import {io, Socket as ClientSocket} from 'socket.io-client';
import {FastifyInstance} from "fastify";
import {default as IORedis, RedisOptions} from 'ioredis';
import {estypes} from "@elastic/elasticsearch";

export interface StreamDeltasRequest {
    code: string;
    table: string;
    scope: string;
    payer: string;
    start_from: number | string;
    read_until: number | string;
}

export interface RequestFilter {
    field: string;
    value: string;
}

export interface StreamActionsRequest {
    contract: string;
    account: string;
    action: string;
    filters: RequestFilter[];
    start_from: number | string;
    read_until: number | string;
}

export interface SearchBody {
    query: estypes.QueryDslQueryContainer,
    sort: estypes.SortOptions
}

async function addBlockRangeOpts(
    data: StreamActionsRequest | StreamDeltasRequest,
    searchBody: SearchBody,
    fastify: FastifyInstance
) {

    let timeRange: {
        "@timestamp": {
            gte?: string;
            lte?: string;
        }
    } | undefined;

    let blockRange: {
        "block_num": {
            gte?: number;
            lte?: number;
        }
    } | undefined;

    let head;

    if (typeof data['start_from'] === 'string' && data['start_from'] !== '') {
        if (!timeRange) {
            timeRange = {"@timestamp": {}};
        }
        timeRange["@timestamp"]['gte'] = data['start_from'];
    }

    if (typeof data['read_until'] === 'string' && data['read_until'] !== '') {
        if (!timeRange) {
            timeRange = {"@timestamp": {}};
        }
        timeRange["@timestamp"]['lte'] = data['read_until'];
    }

    if (typeof data['start_from'] === 'number' && data['start_from'] !== 0) {
        if (!blockRange) {
            blockRange = {"block_num": {}};
        }
        if (data['start_from'] < 0) {
            if (!head) {
                head = (await fastify.eosjs.rpc.get_info()).head_block_num;
            }
            blockRange["block_num"]['gte'] = head + data['start_from'];
        } else {
            blockRange["block_num"]['gte'] = data['start_from'];
        }
    }

    if (typeof data['read_until'] === 'number' && data['read_until'] !== 0) {
        if (!blockRange) {
            blockRange = {"block_num": {}};
        }
        if (data['read_until'] < 0) {
            if (!head) {
                head = (await fastify.eosjs.rpc.get_info()).head_block_num;
            }
            blockRange["block_num"]['lte'] = head + data['read_until'];
        } else {
            blockRange["block_num"]['lte'] = data['read_until'];
        }
    }

    if (Array.isArray(searchBody.query.bool?.must) && searchBody.query.bool?.must) {
        if (timeRange) {
            searchBody.query.bool.must.push({range: timeRange});
        }
        if (blockRange) {
            searchBody.query.bool.must.push({range: blockRange});
        }
    }
}

function addTermMatch(data: Record<string, any>, searchBody: SearchBody, field: string) {
    if (data[field] !== '*' && data[field] !== '') {
        const termQuery: Record<string, any> = {};
        termQuery[field] = data[field];
        if (Array.isArray(searchBody.query.bool?.must) && searchBody.query.bool?.must) {
            searchBody.query.bool.must.push({'term': termQuery});
        }
    }
}

const deltaQueryFields = ['code', 'table', 'scope', 'payer'];

async function streamPastDeltas(
    fastify: FastifyInstance,
    socket: Socket,
    data: StreamDeltasRequest
) {
    const searchBody: {
        query: estypes.QueryDslQueryContainer,
        sort: estypes.SortOptions
    } = {
        query: {bool: {must: []}},
        sort: {
            block_num: {
                order: "asc"
            }
        }
    };
    await addBlockRangeOpts(data, searchBody, fastify);
    deltaQueryFields.forEach(f => {
        addTermMatch(data, searchBody, f);
    });
    const responseQueue: estypes.SearchResponse<any>[] = [];
    let counter = 0;
    const init_response = await fastify.elastic.search<any>({
        index: fastify.manager.chain + '-delta-*',
        scroll: '30s',
        size: 20,
        ...searchBody,
    });
    responseQueue.push(init_response);
    while (responseQueue.length > 0) {
        const r = responseQueue.shift();
        if (r) {
            const {hits} = r;
            counter += hits.hits.length;
            if (socket.connected) {
                socket.emit('message', {
                    type: 'delta_trace',
                    mode: 'history',
                    messages: hits.hits.map((doc) => doc._source),
                });
            } else {
                hLog('LOST CLIENT');
                break;
            }

            if (hits.total && typeof hits.total !== 'number' && hits.total.value === counter) {
                hLog(`${counter} past deltas streamed to ${socket.id}`);
                break;
            }

            if (r._scroll_id) {
                const next_response = await fastify.elastic.scroll<any>({
                    scroll_id: r._scroll_id,
                    scroll: '30s'
                });
                if (next_response) {
                    responseQueue.push(next_response);
                }
            }
        }
    }
}

async function streamPastActions(
    fastify: FastifyInstance,
    socket: Socket,
    data: StreamActionsRequest
) {
    const search_body: any = {
        query: {bool: {must: []}},
        sort: {
            global_sequence: {
                order: "asc"
            }
        } as estypes.SortOptions,
    };

    await addBlockRangeOpts(data, search_body, fastify);

    if (data.account !== '') {
        search_body.query.bool.must.push({
            bool: {
                should: [
                    {term: {'notified': data.account}},
                    {term: {'act.authorization.actor': data.account}},
                ],
            },
        });
    }

    if (data.contract !== '*' && data.contract !== '') {
        search_body.query.bool.must.push({'term': {'act.account': data.contract}});
    }

    if (data.action !== '*' && data.action !== '') {
        search_body.query.bool.must.push({'term': {'act.name': data.action}});
    }

    const onDemandFilters: any[] = [];
    if (data.filters.length > 0) {
        data.filters.forEach(f => {
            if (f.field && f.value) {
                if (f.field.startsWith('@') && !f.field.startsWith('act.data')) {
                    const _q: Record<string, any> = {};
                    _q[f.field] = f.value;
                    search_body.query.bool.must.push({'term': _q});
                } else {
                    onDemandFilters.push(f);
                }
            }
        });
    }

    const responseQueue: estypes.SearchResponse<any>[] = [];
    let counter = 0;

    const init_response = await fastify.elastic.search({
        index: fastify.manager.chain + '-action-*',
        scroll: '30s',
        size: 20,
        body: search_body,
    });
    responseQueue.push(init_response);
    while (responseQueue.length > 0) {
        const r = responseQueue.shift();
        if (r) {
            const {hits} = r;
            const enqueuedMessages: any[] = [];
            counter += hits.hits.length;
            for (const doc of hits.hits) {
                let allow = false;
                if (onDemandFilters.length > 0) {
                    allow = onDemandFilters.every(filter => {
                        return checkFilter(filter, doc._source);
                    });
                } else {
                    allow = true;
                }
                if (allow) {
                    enqueuedMessages.push(doc._source);
                }
            }
            if (socket.connected) {
                socket.emit('message', {type: 'action_trace', mode: 'history', messages: enqueuedMessages});
            } else {
                hLog('LOST CLIENT');
                break;
            }
            if (hits.total && typeof hits.total !== 'number' && hits.total.value === counter) {
                hLog(`${counter} past actions streamed to ${socket.id}`);
                break;
            }

            if (!init_response.hits.total) break;

            if (typeof init_response.hits.total !== "number" && init_response.hits.total.value < 1000) {
                if (r._scroll_id) {
                    const next_response = await fastify.elastic.scroll({
                        scroll_id: r._scroll_id,
                        scroll: '30s'
                    });
                    if (next_response) {
                        responseQueue.push(next_response);
                    }
                }
            } else {
                hLog('Request too large!');
                socket.emit('message', {type: 'action_trace', mode: 'history', messages: []});
            }
        }
    }
}

export class SocketManager {

    private io: Server;
    private relay?: ClientSocket;
    relay_restored = true;
    relay_down = false;
    private readonly url;
    private readonly server: FastifyInstance;

    constructor(fastify: FastifyInstance, relayUrl: string, redisOptions: RedisOptions) {
        this.server = fastify;
        this.url = relayUrl;

        this.io = new Server(fastify.server, {
            allowEIO3: true,
            transports: ['websocket', 'polling'],
        });

        const pubClient = new IORedis.default(redisOptions);
        const subClient = pubClient.duplicate();
        this.io.adapter(createAdapter({pubClient, subClient}));

        this.io.on('connection', (socket: Socket) => {

            if (socket.handshake.headers['x-forwarded-for']) {
                hLog(`[socket] ${socket.id} connected via ${socket.handshake.headers['x-forwarded-for']}`);
            }

            socket.emit('message', {
                event: 'handshake',
                chain: fastify.manager.chain,
            });

            if (this.relay) {
                this.relay.emit('event', {
                    type: 'client_count',
                    counter: this.io.sockets.sockets.size,
                });
            }

            socket.on('delta_stream_request', async (data: StreamDeltasRequest, callback) => {
                if (typeof callback === 'function' && data) {
                    try {
                        if (data.start_from) {
                            await streamPastDeltas(this.server, socket, data);
                        }
                        this.emitToRelay(data, 'delta_request', socket, callback);
                    } catch (e: any) {
                        console.log(e);
                    }
                }
            });

            socket.on('action_stream_request', async (data: StreamActionsRequest, callback) => {
                if (typeof callback === 'function' && data) {
                    try {
                        if (data.start_from) {
                            await streamPastActions(this.server, socket, data);
                        }
                        this.emitToRelay(data, 'action_request', socket, callback);
                    } catch (e: any) {
                        console.log(e);
                    }
                }
            });

            socket.on('disconnect', (reason) => {
                hLog(`[socket] ${socket.id} disconnected - ${reason}`);
                if (this.relay) {
                    this.relay.emit('event', {
                        type: 'client_disconnected',
                        id: socket.id,
                        reason,
                    });
                }
            });
        });
        hLog('Websocket manager loaded!');
    }

    startRelay() {
        hLog(`starting relay - ${this.url}`);

        this.relay = io(this.url, {path: '/router'});

        this.relay.on('connect', () => {
            hLog('Relay Connected!');
            if (this.relay_down) {
                this.relay_restored = true;
                this.relay_down = false;
                this.io.emit('status', 'relay_restored');
            }
        });

        this.relay.on('disconnect', () => {
            hLog('Relay disconnected!');
            this.io.emit('status', 'relay_down');
            this.relay_down = true;
            this.relay_restored = false;
        });

        this.relay.on('delta', (traceData) => {
            this.emitToClient(traceData, 'delta_trace');
        });

        this.relay.on('trace', (traceData) => {
            this.emitToClient(traceData, 'action_trace');
        });

        // Relay LIB info to clients;
        this.relay.on('lib_update', (data) => {
            if (this.server.manager.conn.chains[this.server.manager.chain].chain_id === data.chain_id) {
                this.io.emit('lib_update', data);
            }
        });

        // Relay LIB info to clients;
        this.relay.on('fork_event', (data) => {
            hLog(data);
            if (this.server.manager.conn.chains[this.server.manager.chain].chain_id === data.chain_id) {
                this.io.emit('fork_event', data);
            }
        });
    }

    emitToClient(traceData: any, type: string) {
        if (this.io.sockets.sockets.has(traceData.client)) {
            this.io.sockets.sockets.get(traceData.client)?.emit('message', {
                type: type,
                mode: 'live',
                message: traceData.message,
            });
        }
    }

    emitToRelay(data: any, type: string, socket: Socket, callback: (r: any) => void) {
        if (this.relay && this.relay.connected) {
            this.relay.emit('event', {
                type: type,
                client_socket: socket.id,
                request: data,
            }, (response: any) => {
                callback(response);
            });
        } else {
            callback('STREAMING_OFFLINE');
        }
    }
}
