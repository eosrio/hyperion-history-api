import {Channel, Message} from "amqplib/callback_api";
import {ConnectionManager} from "../connections/manager.class";
import * as _ from "lodash";
import {hLog} from "./common_functions";
import {createHash} from "crypto";

function makeScriptedOp(id, body) {
    return [
        {update: {_id: id, retry_on_conflict: 3}},
        {script: {id: "updateByBlock", params: body}, scripted_upsert: true, upsert: {}}
    ];
}

function flatMap(payloads, builder) {
    return _(payloads).map(payload => {
        const body = JSON.parse(payload.content);
        return builder(payload, body);
    }).flatten()['value']();
}

function buildActionBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = body['global_sequence'];
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    });
}

function buildBlockBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = body['block_num'];
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    });
}

function buildAbiBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = body['block'] + body['account'];
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    });
}

function buildDeltaBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, b) => {
        const _p = b.present ? 1 : 0;
        const id = `${b.block_num}-${b.code}-${b.scope}-${b.table}-${_p}-${b.primary_key}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, b];
    });
}

function buildTableProposalsBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.proposer}-${body.proposal_name}-${body.primary_key}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

function buildTableAccountsBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.code}-${body.scope}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

function buildTableVotersBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.voter}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

function buildLinkBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.account}-${body.permission}-${body.code}-${body.action}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

function buildPermBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.owner}-${body.name}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

function buildResLimitBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.owner}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

function buildResUsageBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.owner}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

function buildGenTrxBulk(payloads, messageMap) {
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

function buildTrxErrBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = body.trx_id.toLowerCase();
        delete body.trx_id;
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    });
}

interface IndexDist {
    index: string;
    first_block: number;
    last_block: number;
}

export class ElasticRoutes {
    public routes: any;
    cm: ConnectionManager;
    chain: string;
    ingestNodeCounters = {};
    distributionMap: IndexDist[];

    constructor(connectionManager: ConnectionManager, distributionMap: IndexDist[]) {
        this.distributionMap = distributionMap;
        this.routes = {generic: this.handleGenericRoute.bind(this)};
        this.cm = connectionManager;
        this.chain = this.cm.chain;
        this.registerRoutes();
        this.resetCounters();
    }

    createGenericBuilder(collection, channel, counter, index_name, method) {
        return new Promise((resolve) => {
            const messageMap = new Map();
            this.bulkAction({
                index: index_name,
                type: '_doc',
                body: method(collection, messageMap)
            }).then((resp: any) => {
                if (resp.errors) {
                    this.ackOrNack(resp, messageMap, channel);
                } else {
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

    async handleGenericRoute(payload: Message[], channel: Channel, cb: (indexed_size: number) => void): Promise<void> {
        const collection = {};
        for (const message of payload) {
            const type = message.properties.headers.type;
            if (!collection[type]) {
                collection[type] = [];
            }
            collection[type].push(message);
        }

        const queue = [];
        let counter = 0;

        if (collection['permission']) {
            queue.push(this.createGenericBuilder(collection['permission'],
                channel, counter, this.chain + '-perm', buildPermBulk));
        }

        if (collection['permission_link']) {
            queue.push(this.createGenericBuilder(collection['permission_link'],
                channel, counter, this.chain + '-link', buildLinkBulk));
        }

        if (collection['resource_limits']) {
            queue.push(this.createGenericBuilder(collection['resource_limits'],
                channel, counter, this.chain + '-reslimits', buildResLimitBulk));
        }

        if (collection['resource_usage']) {
            queue.push(this.createGenericBuilder(collection['resource_usage'],
                channel, counter, this.chain + '-userres', buildResUsageBulk));
        }

        if (collection['generated_transaction']) {
            queue.push(this.createGenericBuilder(collection['generated_transaction'],
                channel, counter, this.chain + '-gentrx', buildGenTrxBulk));
        }

        if (collection['trx_error']) {
            queue.push(this.createGenericBuilder(collection['trx_error'],
                channel, counter, this.chain + '-trxerr', buildTrxErrBulk));
        }

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

    ackOrNack(resp, messageMap, channel: Channel) {
        for (const item of resp.items) {
            let id, itemBody;
            if (item['index']) {
                id = item.index._id;
                itemBody = item.index;
            } else if (item['update']) {
                id = item.update._id;
                itemBody = item.update;
            } else {
                console.log(item);
                throw new Error('FATAL ERROR - CANNOT EXTRACT ID');
            }
            const message = messageMap.get(id);
            const status = itemBody.status;
            if (message) {
                if (status === 409) {
                    console.log(item);
                    channel.nack(message);
                } else if (status !== 201 && status !== 200) {
                    channel.nack(message);
                    console.log(item);
                    console.info(`nack id: ${id} - status: ${status}`);
                } else {
                    channel.ack(message);
                }
            } else {
                console.log(item);
                throw new Error('Message not found');
            }
        }
    }

    onResponse(resp, messageMap, callback, payloads, channel: Channel) {
        if (resp.errors) {
            this.ackOrNack(resp, messageMap, channel);
        } else {
            channel.ackAll();
        }
        callback(messageMap.size);
    }

    onError(err, channel: Channel, callback) {
        try {
            channel.nackAll();
            hLog('NackAll', err);
        } finally {
            callback();
        }
    }

    bulkAction(bulkData) {
        let minIdx = 0;
        if (this.cm.ingestClients.length > 1) {
            let min;
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
        this.ingestNodeCounters[minIdx].docs += bulkData.body.length;
        if (this.ingestNodeCounters[minIdx].docs > 1000) {
            this.resetCounters();
        }
        return this.cm.ingestClients[minIdx]['bulk'](bulkData);
    }

    getIndexNameByBlock(block_num) {
        if (!this.distributionMap) {
            return null;
        }

        const idx = this.distributionMap.find((value) => {
            return value.first_block <= block_num && value.last_block >= block_num;
        });

        if (idx) {
            return idx.index;
        } else {
            return null;
        }
    }

    addToIndexMap(map, idx, payload) {
        if (idx) {
            if (!map[idx]) {
                map[idx] = [];
            }
            map[idx].push(payload);
        }
    }

    private routeFactory(indexName: string, bulkGenerator) {
        return async (payloads, channel, cb) => {
            let _index = this.chain + '-' + indexName;
            if (this.cm.config.indexer.rewrite) {

                // write to remapped indices
                let payloadBlock = null;
                const indexMap = {};
                let pIdx = null;
                if (indexName === 'action' || indexName === 'delta') {
                    for (const payload of payloads) {
                        const blk = payload.properties.headers?.block_num;
                        if (!payloadBlock) {
                            payloadBlock = blk;
                            pIdx = this.getIndexNameByBlock(blk);
                            this.addToIndexMap(indexMap, pIdx, payload);
                        } else {
                            this.addToIndexMap(
                                indexMap,
                                payloadBlock === blk ? pIdx : this.getIndexNameByBlock(blk),
                                payload
                            );
                        }
                    }
                }

                // if no index was mapped to that range use the default alias
                if (Object.keys(indexMap).length === 0) {
                    indexMap[_index] = payloads;
                }

                const queue = [];
                let counter = 0;

                for (const idxKey in indexMap) {
                    queue.push(this.createGenericBuilder(indexMap[idxKey], channel, counter, idxKey, bulkGenerator));
                }

                const results = await Promise.all(queue);
                results.forEach(value => counter += value);
                cb(counter);
            } else {

                // write to alias
                const messageMap = new Map();
                this.bulkAction({
                    index: _index,
                    type: '_doc',
                    body: bulkGenerator(payloads, messageMap)
                }).then(resp => {
                    this.onResponse(resp, messageMap, cb, payloads, channel);
                }).catch(err => {
                    this.onError(err, channel, cb);
                });
            }
        };
    }

    private addRoute(indexType: string, generator) {
        this.routes[indexType] = this.routeFactory(indexType, generator);
    }

    private registerRoutes() {
        this.addRoute('abi', buildAbiBulk);
        this.addRoute('action', buildActionBulk);
        this.addRoute('block', buildBlockBulk);
        this.addRoute('delta', buildDeltaBulk);
        this.addRoute('table-voters', buildTableVotersBulk);
        this.addRoute('table-accounts', buildTableAccountsBulk);
        this.addRoute('table-proposals', buildTableProposalsBulk);
    }
}
