import {Channel, Message} from "amqplib";
import {ConnectionManager} from "../connections/manager.class.js";
import _ from "lodash";
import {hLog} from "./common_functions.js";
import {createHash} from "crypto";
import {Client, estypes} from "@elastic/elasticsearch";

type MaxBlockCb = (maxBlock: number) => void;
type PartitionRoutingFunction = (blockNum: number) => string;
type MMap = Map<string, any>;

export type BulkGeneratorFunction = (
    payloads: Message[],
    messageMap: MMap,
    maxBlockCb: MaxBlockCb,
    routerFunc: PartitionRoutingFunction,
    indexName: string,
    retry_on_conflict: number
) => any;

export type RouteFunction = (payloads: Message[], channel: Channel, cb: (size?: number) => void) => void;

function makeScriptedOp(id: string, body: any, retry_on_conflict = 3) {
    return [
        {update: {_id: id, retry_on_conflict}},
        {script: {id: "updateByBlock", params: body}, scripted_upsert: true, upsert: {}}
    ];
}

function makeDelOp(id: string) {
    return [
        {delete: {_id: id}}
    ];
}

function flatMap(payloads: Message[], builder: (payload: Message, body: any) => any) {
    return _(payloads).map((payload: Message) => {
        const body = JSON.parse(payload.content.toString());
        return builder(payload, body);
    }).flatten()['value']();
}

function buildAbiBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const id = body['block'] + body['account'];
        messageMap.set(id, _.omit(payload, ['content']));
        return [
            {index: {_id: id}},
            body
        ];
    });
}

function buildActionBulk(payloads: Message[],
                         messageMap: MMap,
                         _maxBlockCb: MaxBlockCb,
                         routerFunc: PartitionRoutingFunction,
                         indexName: string) {
    return flatMap(payloads, (payload, body) => {
        const id = body['global_sequence'];
        messageMap.set(id, _.omit(payload, ['content']));
        return [{
            index: {
                _id: id,
                _index: `${indexName}-${routerFunc(body.block_num)}`
            }
        }, body];
    });
}

function buildBlockBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload: any, body: any) => {
        const id = body['block_num'];
        messageMap.set(id, _.omit(payload, ['content']));
        return [{
            index: {_id: id}
        }, body];
    });
}

function buildDeltaBulk(payloads: Message[],
                        messageMap: MMap,
                        maxBlockCb: MaxBlockCb,
                        routerFunc: PartitionRoutingFunction,
                        indexName: string,
                        _retry_on_conflict: number
) {
    let maxBlock = 0;

    const flat_map = flatMap(payloads, (payload, body) => {
        if (maxBlock < body.block_num) {
            maxBlock = body.block_num;
        }
        const id = `${body.block_num}-${body.code}-${body.scope}-${body.table}-${body.primary_key}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return [
            {
                index: {
                    _id: id,
                    _index: `${indexName}-${routerFunc(body.block_num)}`
                }
            },
            body
        ];
    });

    maxBlockCb(maxBlock);
    return flat_map;
}

function buildDynamicTableBulk(payloads: any[],
                               messageMap: MMap,
                               _maxBlockCb: MaxBlockCb,
                               _routerFunc: PartitionRoutingFunction,
                               _indexName: string,
                               retry_on_conflict: number
) {
    return flatMap(payloads, (payload, body) => {
        messageMap.set(body.id, _.omit(payload, ['content']));
        if (body.present === 0) {
            return makeDelOp(body.id);
        } else {
            return makeScriptedOp(body.id, body, retry_on_conflict);
        }
    });
}

function buildTableProposalsBulk(payloads: Message[],
                                 messageMap: MMap,
                                 _maxBlockCb: MaxBlockCb,
                                 _routerFunc: PartitionRoutingFunction,
                                 _indexName: string,
                                 retry_on_conflict: number
) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.proposer}-${body.proposal_name}-${body.primary_key}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body, retry_on_conflict);
    });
}

function buildTableAccountsBulk(payloads: Message[],
                                messageMap: MMap,
                                _maxBlockCb: MaxBlockCb,
                                _routerFunc: PartitionRoutingFunction,
                                _indexName: string,
                                retry_on_conflict: number
) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.code}-${body.scope}-${body.symbol}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body, retry_on_conflict);
    });
}

function buildTableVotersBulk(payloads: Message[],
                              messageMap: MMap,
                              _maxBlockCb: MaxBlockCb,
                              _routerFunc: PartitionRoutingFunction,
                              _indexName: string,
                              retry_on_conflict: number
) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.voter}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body, retry_on_conflict);
    });
}

function buildLinkBulk(payloads: Message[],
                       messageMap: MMap,
                       _maxBlockCb: MaxBlockCb,
                       _routerFunc: PartitionRoutingFunction,
                       _indexName: string,
                       retry_on_conflict: number
) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.account}-${body.permission}-${body.code}-${body.action}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body, retry_on_conflict);
    });
}

function buildPermBulk(payloads: Message[],
                       messageMap: MMap,
                       _maxBlockCb: MaxBlockCb,
                       _routerFunc: PartitionRoutingFunction,
                       _indexName: string,
                       retry_on_conflict: number
) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.owner}-${body.name}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body, retry_on_conflict);
    });
}

function buildResLimitBulk(payloads: Message[],
                           messageMap: MMap,
                           _maxBlockCb: MaxBlockCb,
                           _routerFunc: PartitionRoutingFunction,
                           _indexName: string,
                           retry_on_conflict: number
) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.owner}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body, retry_on_conflict);
    });
}

function buildResUsageBulk(payloads: Message[],
                           messageMap: MMap,
                           _maxBlockCb: MaxBlockCb,
                           _routerFunc: PartitionRoutingFunction,
                           _indexName: string,
                           retry_on_conflict: number
) {
    return flatMap(payloads, (payload: Message, body) => {
        const id = `${body.owner}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body, retry_on_conflict);
    });
}

function buildScheduleBulk(payloads: Message[],
                           messageMap: MMap,
                           _maxBlockCb: MaxBlockCb,
                           _routerFunc: PartitionRoutingFunction,
                           _indexName: string,
                           retry_on_conflict: number
) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.version}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body, retry_on_conflict);
    });
}

function buildGenTrxBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const hash = createHash('sha256')
            .update(body.sender + body.sender_id + body.payer)
            .digest()
            .toString("hex");
        const id = `${body.block_num}-${hash}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    });
}

function buildTrxErrBulk(payloads: Message[], messageMap: MMap) {
    return flatMap(payloads, (payload, body) => {
        const id = body.trx_id.toLowerCase();
        delete body.trx_id;
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    });
}

const generatorsMap = {
    resource_limits: {
        index_name: 'reslimits',
        func: buildResLimitBulk
    },
    resource_usage: {
        index_name: 'userres',
        func: buildResUsageBulk
    },
    schedule: {
        index_name: 'schedule',
        func: buildScheduleBulk
    },
    generated_transaction: {
        index_name: 'gentrx',
        func: buildGenTrxBulk
    },
    trx_error: {
        index_name: 'trxerr',
        func: buildTrxErrBulk
    },
};

export class ElasticRoutes {
    public routes: Record<string, RouteFunction>;
    cm: ConnectionManager;
    chain: string;
    ingestNodeCounters = {};
    retryOnConflict: number = 3;

    constructor(connectionManager: ConnectionManager, private readonly onSettlementFailure?: (channel: Channel) => void) {
        this.routes = {
            generic: this.handleGenericRoute.bind(this)
        };
        this.cm = connectionManager;
        this.chain = this.cm.chain;

        if (this.cm.config.scaling.indexing_queues) {
            this.retryOnConflict = this.cm.config.scaling.indexing_queues + 3;
        }

        this.registerRoutes();
        this.resetCounters();
    }

    async createGenericBuilder(
        collection: Message[],
        channel: Channel,
        index_name: string,
        method: BulkGeneratorFunction
    ): Promise<number> {
        if (collection.length === 0) return 0;
        let channelOpen = true;
        const onClose = () => { channelOpen = false; };
        channel.once('close', onClose);
        try {
            let maxBlockNum = 0;
            let statuses: number[];
            let response: estypes.BulkResponse;
            try {
                const operations = method(collection, new Map(), maxBlock => {
                    maxBlockNum = maxBlock;
                }, this.getIndexPartition.bind(this), index_name, this.retryOnConflict);
                const bulkResult = this.bulkAction({ index: index_name, operations });
                if (!bulkResult) throw new Error('Unexpected index request with no operations');
                response = await bulkResult;
                if (!channelOpen) return 0;
                statuses = this.validateBulkResponse(response, operations, collection.length);
            } catch (reason) {
                if (!channelOpen) return 0;
                hLog('Elasticsearch batch remains pending:', reason);
                try {
                    // A bulk rejection must not requeue prefetched deliveries or
                    // other generic subrequests sharing this channel.
                    for (const message of collection) channel.nack(message, false, true);
                } catch (settlementError) {
                    hLog('Failed to requeue Elasticsearch batch:', settlementError);
                    await this.closeChannel(channel);
                }
                return 0;
            }

            let indexed = 0;
            try {
                for (let i = 0; i < collection.length; i++) {
                    const status = statuses[i];
                    if (status === 200 || status === 201) {
                        channel.ack(collection[i]);
                        indexed++;
                    } else if (status === 404) {
                        // Preserve the existing missing-document disposition.
                        channel.ack(collection[i]);
                    } else {
                        hLog('Retrying Elasticsearch bulk item:', response.items[i]);
                        channel.nack(collection[i], false, true);
                    }
                }
            } catch (reason) {
                // Some tags may already be settled. Closing returns only the
                // remaining deliveries without acknowledging any tag twice.
                hLog('Failed to settle Elasticsearch batch:', reason);
                await this.closeChannel(channel);
                return 0;
            }
            if (indexed === collection.length && maxBlockNum > 0) {
                ElasticRoutes.reportMaxBlock(maxBlockNum, index_name);
            }
            return indexed;
        } finally {
            channel.removeListener('close', onClose);
        }
    }

    private async closeChannel(channel: Channel): Promise<void> {
        try {
            await channel.close();
        } catch (reason) {
            hLog('Failed to close Elasticsearch delivery channel:', reason);
        } finally {
            // Closing an individual AMQP channel does not reconnect its still
            // open connection. Let the host recover its consumer as well.
            this.onSettlementFailure?.(channel);
        }
    }

    private validateBulkResponse(response: estypes.BulkResponse, operations: any[], count: number): number[] {
        if (!response || typeof response.errors !== 'boolean' || !Array.isArray(response.items) || response.items.length !== count) {
            throw new Error('Incomplete Elasticsearch bulk response');
        }
        const statuses: number[] = [];
        let offset = 0;
        for (const item of response.items) {
            const operation = operations[offset];
            const operationKeys = operation && Object.keys(operation);
            const kind = operationKeys?.[0];
            if (operationKeys?.length !== 1 || !['index', 'update', 'delete'].includes(kind)) {
                throw new Error('Invalid Elasticsearch bulk operation');
            }
            const itemKeys = item && Object.keys(item);
            const result = item?.[kind];
            if (itemKeys?.length !== 1 || itemKeys[0] !== kind || !result ||
                operation[kind]._id == null || result._id !== String(operation[kind]._id) ||
                !Number.isInteger(result.status) || result.status < 200 || result.status > 599 ||
                (result.status < 300 && result.error != null)) {
                throw new Error('Invalid Elasticsearch bulk item response');
            }
            statuses.push(result.status);
            offset += kind === 'delete' ? 1 : 2;
        }
        if (offset !== operations.length) throw new Error('Incomplete Elasticsearch bulk operation results');
        return statuses;
    }

    async handleGenericRoute(payload: Message[], ch: Channel, cb: (indexed_size: number) => void): Promise<void> {
        const coll: Record<string, Message[]> = {};
        for (const message of payload) {
            const type = message.properties.headers?.type;
            if (type) {
                if (!coll[type]) {
                    coll[type] = [];
                }
                coll[type].push(message);
            }
        }
        const queue: Promise<any>[] = [];
        const v = this.cm.config.settings.index_version;
        Object.keys(coll).forEach(value => {
            if (generatorsMap[value]) {
                const indexName = `${this.chain}-${generatorsMap[value].index_name}-${v}`;
                queue.push(this.createGenericBuilder(coll[value], ch, indexName, generatorsMap[value].func));
            }
        });
        const totals = await Promise.all(queue);
        const sum = totals.reduce((a, b) => a + b, 0);
        // hLog(`[Generic] Indexed ${sum} items`);
        cb(sum);
    }

    resetCounters() {
        for (let idx = 0; idx < this.cm.ingestClients.length; idx++) {
            this.ingestNodeCounters[idx] = {status: true, docs: 0};
        }
    }

    selectLeastLoadedIngestClient(opCount: number): Client {
        if (this.cm.ingestClients.length > 1) {
            let minIdx = 0;
            let min: number | null = null;
            for (let i = 0; i < this.cm.ingestClients.length; i++) {
                if (!min) {
                    min = this.ingestNodeCounters[i].docs;
                } else {
                    if (this.ingestNodeCounters[i].docs < min) {
                        min = this.ingestNodeCounters[i].docs;
                        minIdx = i;
                    }
                }
            }
            this.ingestNodeCounters[minIdx].docs += opCount;
            if (this.ingestNodeCounters[minIdx].docs > 10000) {
                this.resetCounters();
            }
            return this.cm.ingestClients[minIdx];
        } else {
            return this.cm.ingestClients[0];
        }
    }

    bulkAction(bulkData: estypes.BulkRequest<any, any>): Promise<estypes.BulkResponse> | null {
        if (!bulkData.operations) {
            return null;
        }
        const client = this.selectLeastLoadedIngestClient(bulkData.operations.length);
        return client.bulk<any, any>(bulkData);
    }

    getIndexPartition(blockNum: number): string {
        return Math.ceil(blockNum / this.cm.config.settings.index_partition_size).toString().padStart(6, '0');
    }

    private routeFactory(indexName: string,
                         bulkGenerator: BulkGeneratorFunction,
                         routerFunction: PartitionRoutingFunction): (payloads: Message[], channel: Channel, cb: (size?: number) => void) => void {
        return (payloads: Message[], channel: Channel, cb: (size?: number) => void) => {
            const index = `${this.chain}-${indexName}-${this.cm.config.settings.index_version}`;
            void this.createGenericBuilder(payloads, channel, index,
                (collection, messageMap, maxBlockCb, _router, indexName, retries) =>
                    bulkGenerator(collection, messageMap, maxBlockCb, routerFunction, indexName, retries)
            ).then(cb);
        };
    }

    private addRoute(indexType: string,
                     bulkGenerator: BulkGeneratorFunction,
                     routerFunction: PartitionRoutingFunction) {
        this.routes[indexType] = this.routeFactory(indexType, bulkGenerator, routerFunction);
    }

    private registerRoutes() {
        const partitionRouter = this.getIndexPartition.bind(this);
        // this.registerDynamicTableRoute();
        this.addRoute('abi', buildAbiBulk, partitionRouter);
        this.addRoute('action', buildActionBulk, partitionRouter);
        this.addRoute('block', buildBlockBulk, partitionRouter);
        this.addRoute('delta', buildDeltaBulk, partitionRouter);
        this.addRoute('table-voters', buildTableVotersBulk, partitionRouter);
        this.addRoute('table-accounts', buildTableAccountsBulk, partitionRouter);
        this.addRoute('table-proposals', buildTableProposalsBulk, partitionRouter);
        // this.addRoute('dynamic-table', buildDynamicTableBulk);
    }

    private registerDynamicTableRoute() {
        this.routes['dynamic-table'] = async (payloads, channel, cb) => {
            const contractMap: Map<string, any[]> = new Map();
            let counter = 0;
            for (const payload of payloads) {
                const headers = payload?.properties?.headers;
                if (headers) {
                    const item = {
                        id: headers.id,
                        block_num: headers.block_num,
                        present: headers.present,
                        content: payload.content,
                        fields: payload.fields,
                        properties: payload.properties
                    };
                    if (contractMap.has(headers.code)) {
                        contractMap.get(headers.code)?.push(item);
                    } else {
                        contractMap.set(headers.code, [item]);
                    }
                }
            }
            const processingQueue: Promise<number>[] = [];
            for (const entry of contractMap.entries()) {
                processingQueue.push(this.createGenericBuilder(
                    entry[1],
                    channel,
                    `${this.chain}-dt-${entry[0]}`,
                    buildDynamicTableBulk
                ));
            }
            const results = await Promise.all(processingQueue);
            results.forEach(value => counter += value);
            cb(counter);
        };
    }

    private static reportMaxBlock(maxBlockNum: number, index_name: string) {
        process.send?.({
            event: 'ingestor_block_report',
            index: index_name,
            proc: process.env.worker_role,
            block_num: maxBlockNum
        });
    }
}
