import {Channel, Message} from "amqplib/callback_api.js";
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
    permission: {
        index_name: 'perm',
        func: buildPermBulk
    },
    permission_link: {
        index_name: 'link',
        func: buildLinkBulk
    },
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

    constructor(connectionManager: ConnectionManager) {
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

    createGenericBuilder(
        collection: Message[],
        channel: Channel,
        index_name: string,
        method: any
    ): Promise<number> {
        return new Promise<number>((resolve) => {
            const messageMap = new Map();
            let maxBlockNum: number;
            const bulkResult = this.bulkAction({
                index: index_name,
                operations: method(collection, messageMap, (maxBlock: number) => {
                    maxBlockNum = maxBlock;
                })
            });
            if (bulkResult) {
                bulkResult.then((resp: any) => {
                    if (resp.errors) {
                        this.ackOrNack(resp, messageMap, channel);
                    } else {
                        if (maxBlockNum > 0) {
                            ElasticRoutes.reportMaxBlock(maxBlockNum, index_name);
                        }
                        channel.ackAll();
                    }
                    resolve(messageMap.size);
                }).catch((err) => {
                    try {
                        channel.nackAll();
                        hLog('NackAll', err);
                    } finally {
                        resolve(0);
                    }
                });
            } else {
                hLog("[FATAL ERROR] Unexpected Index Request with no operations!");
            }
        })
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

    ackOrNack(resp, messageMap, channel: Channel) {
        for (const item of resp.items) {
            let id, itemBody;
            if (item['index']) {
                id = item.index._id;
                itemBody = item.index;
            } else if (item['update']) {
                id = item.update._id;
                itemBody = item.update;
            } else if (item['delete']) {
                id = item.delete._id;
                itemBody = item.delete;
            } else {
                console.log(item);
                throw new Error('FATAL ERROR - CANNOT EXTRACT ID');
            }
            const message = messageMap.get(id);
            const status = itemBody.status;
            if (message) {
                switch (status) {
                    case 200: {
                        channel.ack(message);
                        break;
                    }
                    case 201: {
                        channel.ack(message);
                        break;
                    }
                    case 404: {
                        channel.ack(message);
                        break;
                    }
                    case 409: {
                        console.log(item);
                        channel.nack(message);
                        break;
                    }
                    default: {
                        console.log(item, message.fields.deliveryTag);
                        console.info(`nack id: ${id} - status: ${status}`);
                        channel.nack(message);
                    }
                }
            } else {
                hLog(`Indexing error: ${item.index._index} :: ${item.index._id}`, item?.index?.error);
                // throw new Error('Message not found');
            }
        }
    }

    onResponse(resp, messageMap, callback: (size: number) => void, payloads, channel: Channel, index_name: string, maxBlockNum: number) {
        if (resp.errors) {
            this.ackOrNack(resp, messageMap, channel);
            if (maxBlockNum > 0) {
                ElasticRoutes.reportMaxBlock(maxBlockNum, index_name);
            }
        } else {
            channel.ackAll();
        }
        callback(messageMap.size);
    }

    onError(err: any, channel: Channel, callback: (size?: number) => void) {
        try {
            channel.nackAll();
            if (err.meta) {
                hLog('NackAll:', JSON.stringify(err.meta.meta, null, 2));
            } else {
                hLog('NackAll:', err);
            }
        } finally {
            callback();
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
            let _index = `${this.chain}-${indexName}-${this.cm.config.settings.index_version}`;
            // write directly to index
            const messageMap = new Map();
            let maxBlockNum = 0;
            const bulkResult = this.bulkAction({
                index: _index,
                operations: bulkGenerator(payloads, messageMap, (maxBlock: number) => {
                    maxBlockNum = maxBlock;
                }, routerFunction, _index, this.retryOnConflict)
            });
            if (bulkResult) {
                bulkResult.then(resp => {
                    this.onResponse(resp, messageMap, cb, payloads, channel, _index, maxBlockNum);
                }).catch(err => {
                    this.onError(err, channel, cb);
                });
            }
        };
    }

    private addRoute(indexType: string,
                     bulkGenerator: BulkGeneratorFunction,
                     routerFunction: PartitionRoutingFunction) {
        this.routes[indexType] = this.routeFactory(indexType, bulkGenerator, routerFunction);
    }

    private registerRoutes() {
        const partitionRouter = this.getIndexPartition.bind(this);
        this.registerDynamicTableRoute();
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
