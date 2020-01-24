const {
    buildActionBulk,
    buildBlockBulk,
    buildAbiBulk,
    buildDeltaBulk,
    buildTableAccountsBulk,
    buildTableProposalsBulk,
    buildTableVotersBulk
} = require("./bulkBuilders");
const config = require(`../${process.env.CONFIG_JSON}`);
const chain = config.settings.chain;
const prettyjson = require('prettyjson');

const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

const ingestClients = manager.ingestClients;
const ingestNodeCounters = {};

function resetCounters() {
    ingestClients.forEach((val, idx) => {
        ingestNodeCounters[idx] = {
            status: true,
            docs: 0
        };
    });
}

resetCounters();

function bulkAction(bulkData) {
    let minIdx = 0;
    if (ingestClients.length > 1) {
        let min;
        ingestClients.forEach((val, idx) => {
            if (!min) {
                min = ingestNodeCounters[idx].docs;
            } else {
                if (ingestNodeCounters[idx].docs < min) {
                    min = ingestNodeCounters[idx].docs;
                    minIdx = idx;
                }
            }
        });
    }
    ingestNodeCounters[minIdx].docs += bulkData.body.length;
    if (ingestNodeCounters[minIdx].docs > 1000) {
        resetCounters();
    }
    return ingestClients[minIdx]['bulk'](bulkData);
}

function ackOrNack(resp, messageMap, channel) {
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
                console.log(prettyjson.render(item));
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

function onResponse(resp, messageMap, callback, payloads, channel) {
    process.send({event: 'add_index', size: payloads.length});
    if (resp.errors) {
        ackOrNack(resp, messageMap, channel);
    } else {
        channel.ackAll();
    }
    callback();
}

function onError(err, channel, callback) {
    try {
        channel.nackAll();
        console.log('nack all', err.stack);
    } finally {
        callback();
    }
}


// Define index routes
const routes = {};

routes['action'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    const t0 = Date.now();
    bulkAction({
        index: chain + '-action',
        type: '_doc',
        body: buildActionBulk(payloads, messageMap)
    }).then(resp => {
        // console.log('Bulk index actions - ' + (Date.now() - t0) + "ms - " + payloads.length + ' actions');
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

routes['delta'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    const t0 = Date.now();
    bulkAction({
        index: chain + '-delta',
        type: '_doc',
        body: buildDeltaBulk(payloads, messageMap)
    }).then(resp => {
        // console.log('Bulk index deltas - ' + (Date.now() - t0) + "ms");
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

routes['block'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    bulkAction({
        index: chain + '-block',
        type: '_doc',
        body: buildBlockBulk(payloads, messageMap)
    }).then(resp => {
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

routes['table-proposals'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    bulkAction({
        index: chain + '-table-proposals',
        type: '_doc',
        body: buildTableProposalsBulk(payloads, messageMap)
    }).then(resp => {
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

routes['table-accounts'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    bulkAction({
        index: chain + '-table-accounts',
        type: '_doc',
        body: buildTableAccountsBulk(payloads, messageMap)
    }).then(resp => {
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

routes['table-voters'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    bulkAction({
        index: chain + '-table-voters',
        type: '_doc',
        body: buildTableVotersBulk(payloads, messageMap)
    }).then(resp => {
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

routes['abi'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    bulkAction({
        index: chain + '-abi',
        type: '_doc',
        body: buildAbiBulk(payloads, messageMap)
    }).then(resp => {
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

module.exports = {routes};
