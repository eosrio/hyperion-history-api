import {Channel, Message} from "amqplib";
import {ConnectionManager} from "../connections/manager.class.js";
import {flat} from 'radash';
import {hLog} from "./common_functions.js";
import {estypes} from "@elastic/elasticsearch";
import {
    buildAbiBulk,
    buildActionBulk,
    buildBlockBulk,
    buildDeltaBulk,
    buildDynamicTableBulk,
    buildGenTrxBulk,
    buildLinkBulk,
    buildPermBulk,
    buildResLimitBulk,
    buildResUsageBulk,
    buildTableAccountsBulk,
    buildTableProposalsBulk,
    buildTableVotersBulk,
    buildTrxErrBulk
} from "./builders.js";

export type MaxBlockCb = (maxBlock: number) => void;
export type RouterFunction = (blockNum: number) => string;
export type flatMapBuilder = (payload: Message, body: any) => {
    index?: {
        _id: any,
        _index?: string
    },
    update?: {
        _id: any,
        retry_on_conflict: number
    },
    script?: {
        id: string
        params?: any
    }
    scripted_upsert?: boolean
    upsert?: any
    delete?: {
        _id: any
    }
} | any;
export type MMap = Map<string, any>;
export type BulkGenerator = (
    payloads: Message[],
    messageMap: MMap,
    maxBlockCb: MaxBlockCb,
    routerFunc: RouterFunction | null,
    indexName: string
) => any[];

export function makeScriptedOp(id: string, body: any) {
    return [
        {update: {_id: id, retry_on_conflict: 3}},
        {script: {id: "updateByBlock", params: body}, scripted_upsert: true, upsert: {}}
    ];
}

export function makeDelOp(id: string) {
    return [
        {delete: {_id: id}}
    ];
}

export function flatMap(payloads: Message[], builder: flatMapBuilder): any[] {
    return flat(payloads.map((payload: Message) => {
        return builder(payload, JSON.parse(payload.content.toString()));
    }));
}

const generatorsMap: Record<string, {
    index_name: string,
    func: (payloads: Message[], messageMap: MMap) => any[]
}> = {
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
    generated_transaction: {
        index_name: 'gentrx',
        func: buildGenTrxBulk
    },
    trx_error: {
        index_name: 'trxerr',
        func: buildTrxErrBulk
    },
};

interface IndexDist {
    index: string;
    first_block: number;
    last_block: number;
}

export class ElasticRoutes {
    public routes: any;
    cm: ConnectionManager;
    chain: string;
    ingestNodeCounters: Record<number, any> = {};
    distributionMap: IndexDist[];

    constructor(connectionManager: ConnectionManager, distributionMap: IndexDist[]) {
        this.distributionMap = distributionMap;
        this.routes = {generic: this.handleGenericRoute.bind(this)};
        this.cm = connectionManager;
        this.chain = this.cm.chain;
        this.registerRoutes();
        this.resetCounters();
    }

    createGenericBuilder(
        collection: Message[],
        channel: Channel,
        index_name: string,
        method: (payloads: Message[], messageMap: MMap, updateBlock?: (maxBlock: number) => void) => any[]
    ) {
        return new Promise((resolve) => {
            const messageMap = new Map();
            let maxBlockNum: number;
            const ops = method(collection, messageMap, (maxBlock: number) => {
                maxBlockNum = maxBlock;
            });
            this.bulkAction({
                index: index_name,
                operations: ops
            }).then((resp: estypes.BulkResponse) => {
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
        })
    }

    async handleGenericRoute(
        payload: Message[],
        ch: Channel,
        cb: (indexed_size: number) => void
    ): Promise<void> {
        const coll: Record<string, Message[]> = {};
        for (const message of payload) {
            const type = message.properties.headers.type;
            if (!coll[type]) {
                coll[type] = [];
            }
            coll[type].push(message);
        }
        const queue: any[] = [];
        const v = this.cm.config.settings.index_version;
        let counter = 0;
        Object.keys(coll).forEach(value => {
            if (generatorsMap[value]) {
                const indexName = `${this.chain}-${generatorsMap[value].index_name}-${v}`;
                queue.push(this.createGenericBuilder(coll[value], ch, indexName, generatorsMap[value].func));
            }
        });
        await Promise.all(queue);
        cb(counter);
    }

    resetCounters() {
        this.cm.ingestClients.forEach((val, idx) => {
            this.ingestNodeCounters[idx] = {
                status: true,
                docs: 0
            };
        });
    }

    ackOrNack(resp: estypes.BulkResponse, messageMap: MMap, channel: Channel) {
        for (const item of resp.items) {
            let id;
            let itemBody;
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
            if (id) {
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
                    console.log(item);
                    throw new Error('Message not found');
                }
            } else {
                console.log(item);
                throw new Error('Message not found');
            }
        }
    }

    onResponse(
        resp: estypes.BulkResponse,
        messageMap: MMap,
        callback: (counter: number) => void,
        channel: Channel,
        index_name: string,
        maxBlockNum: number
    ): void {
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

    onError(err: any, channel: Channel, callback: () => void) {
        try {
            channel.nackAll();
            if (err.meta) {
                hLog('NackAll:', JSON.stringify(err.meta.error, null, 2));
            } else {
                hLog('NackAll:', err);
            }
        } finally {
            callback();
        }
    }

    bulkAction(bulkData: estypes.BulkRequest<any, any>): Promise<estypes.BulkResponse> {
        let minIdx = 0;
        if (this.cm.ingestClients.length > 1) {
            let min: number | undefined;
            this.cm.ingestClients.forEach((val, idx) => {
                if (!min) {
                    min = this.ingestNodeCounters[idx].docs;
                } else {
                    if (this.ingestNodeCounters[idx].docs < min) {
                        min = this.ingestNodeCounters[idx].docs;
                        minIdx = idx;
                    }
                }
            });
        }
        this.ingestNodeCounters[minIdx].docs += bulkData.operations?.length;
        if (this.ingestNodeCounters[minIdx].docs > 10000) {
            this.resetCounters();
        }
        return this.cm.ingestClients[minIdx].bulk<any, any>(bulkData);
    }

    getIndexPartition(blockNum: number): string {
        if (!blockNum) {
            process.exit(1);
        }
        return Math.ceil(blockNum / this.cm.config.settings.index_partition_size).toString().padStart(6, '0');
    }

    private routeFactory(
        indexName: string,
        bulkGenerator: BulkGenerator,
        routerFunction: RouterFunction | null
    ) {
        return async (payloads: Message[], channel: Channel, cb: () => void) => {
            let _index = `${this.chain}-${indexName}-${this.cm.config.settings.index_version}`;
            const messageMap: MMap = new Map();
            let maxBlockNum: number;
            const ops = bulkGenerator(payloads, messageMap, (maxBlock) => {
                maxBlockNum = maxBlock;
            }, routerFunction, _index);
            this.bulkAction({index: _index, operations: ops}).then((resp: estypes.BulkResponse) => {
                this.onResponse(resp, messageMap, cb, channel, _index, maxBlockNum);
            }).catch((err: any) => {
                this.onError(err, channel, cb);
            });
        };
    }

    private addRoute(indexType: string, bulkGenerator: BulkGenerator, routerFunction: RouterFunction | null) {
        this.routes[indexType] = this.routeFactory(indexType, bulkGenerator, routerFunction);
    }

    private registerRoutes() {
        this.registerDynamicTableRoute();
        const partitionRouter = this.getIndexPartition.bind(this);
        this.addRoute('abi', buildAbiBulk, null);
        this.addRoute('action', buildActionBulk, partitionRouter);
        this.addRoute('block', buildBlockBulk, partitionRouter);
        this.addRoute('delta', buildDeltaBulk, partitionRouter);
        this.addRoute('table-voters', buildTableVotersBulk, null);
        this.addRoute('table-accounts', buildTableAccountsBulk, null);
        this.addRoute('table-proposals', buildTableProposalsBulk, null);
        // this.addRoute('dynamic-table', buildDynamicTableBulk);
    }

    private registerDynamicTableRoute() {
        this.routes['dynamic-table'] = async (payloads: Message[], channel: Channel, cb: (counter: number) => void) => {
            const contractMap: Map<string, any[]> = new Map();
            let counter = 0;
            for (const payload of payloads) {
                const headers = payload?.properties?.headers;
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
            const processingQueue: any[] = [];
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
