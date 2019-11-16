const {
    buildActionBulk,
    buildBlockBulk,
    buildAbiBulk,
    buildDeltaBulk,
    buildTableAccountsBulk,
    buildTableProposalsBulk,
    buildTableVotersBulk
} = require("./bulkBuilders");
const queue_prefix = process.env.CHAIN;
const prettyjson = require('prettyjson');

const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

const client = manager.elasticsearchClient;

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
    client['bulk']({
        index: queue_prefix + '-action',
        type: '_doc',
        body: buildActionBulk(payloads, messageMap)
    }).then(resp => {
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

routes['block'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    client['bulk']({
        index: queue_prefix + '-block',
        type: '_doc',
        body: buildBlockBulk(payloads, messageMap)
    }).then(resp => {
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

routes['delta'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    client['bulk']({
        index: queue_prefix + '-delta',
        type: '_doc',
        body: buildDeltaBulk(payloads, messageMap)
    }).then(resp => {
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

routes['table-proposals'] = async (payloads, channel, cb) => {
    const messageMap = new Map();
    client['bulk']({
        index: queue_prefix + '-table-proposals',
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
    client['bulk']({
        index: queue_prefix + '-table-accounts',
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
    client['bulk']({
        index: queue_prefix + '-table-voters',
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
    client['bulk']({
        index: queue_prefix + '-abi',
        type: '_doc',
        body: buildAbiBulk(payloads, messageMap)
    }).then(resp => {
        onResponse(resp, messageMap, cb, payloads, channel);
    }).catch(err => {
        onError(err, channel, cb);
    });
};

module.exports = {routes};
