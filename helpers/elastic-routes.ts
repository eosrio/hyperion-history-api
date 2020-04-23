import {Channel, Message} from "amqplib/callback_api";
import {ConnectionManager} from "../connections/manager.class";
import * as _ from "lodash";
import {hLog} from "./common_functions";

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
    return flatMap(payloads, (payload, body) => {
        const id = `${body.block_num}-${body.code}-${body.scope}-${body.table}-${body.payer}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
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
        const id = `${body.code}-${body.scope}-${body.primary_key}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    });
}

function buildTableVotersBulk(payloads, messageMap) {
    return flatMap(payloads, (payload, body) => {
        const id = `${body.primary_key}`;
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

export class ElasticRoutes {
    public routes: any;
    cm: ConnectionManager;
    chain: string;
    ingestNodeCounters = {};

    constructor(connectionManager: ConnectionManager) {
        this.routes = {
            generic: this.handleGenericRoute.bind(this)
        };
        this.cm = connectionManager;
        this.chain = this.cm.chain;
        this.registerRoutes();
        this.resetCounters();
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

        if (collection['permission']) {
            const messageMap = new Map();
            this.bulkAction({
                index: this.chain + '-perm',
                type: '_doc',
                body: buildPermBulk(collection['permission'], messageMap)
            }).then(resp => {
                this.onResponse(resp, messageMap, cb, collection['permission'], channel);
            }).catch(err => {
                this.onError(err, channel, cb);
            });
        }

        if (collection['permission_link']) {
            const messageMap = new Map();
            this.bulkAction({
                index: this.chain + '-link',
                type: '_doc',
                body: buildLinkBulk(collection['permission_link'], messageMap)
            }).then(resp => {
                this.onResponse(resp, messageMap, cb, collection['permission_link'], channel);
            }).catch(err => {
                this.onError(err, channel, cb);
            });
        }
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

    private routeFactory(indexName: string, bulkGenerator) {
        return async (payloads, channel, cb) => {
            const messageMap = new Map();
            this.bulkAction({
                index: this.chain + '-' + indexName,
                type: '_doc',
                body: bulkGenerator(payloads, messageMap)
            }).then(resp => {
                this.onResponse(resp, messageMap, cb, payloads, channel);
            }).catch(err => {
                this.onError(err, channel, cb);
            });
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
