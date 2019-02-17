const elasticsearch = require('elasticsearch');
const {buildActionBulk, buildTransactionBulk, buildBlockBulk} = require("./bulkBuilders");
const client = new elasticsearch.Client({
    host: process.env.ES_HOST
});
const queue_prefix = process.env.CHAIN;

const prettyjson = require('prettyjson');

function ackOrNack(resp, messageMap, channel) {
    resp.items.forEach(item => {
        const message = messageMap[item.index._id];
        delete messageMap[item.index._id];
        if (item.index.status !== 201 && item.index.status !== 200) {
            channel.nack(message);
            console.log(prettyjson.render(item.index));
            console.info(`nack ${item.index._id} ${item.index.status}`);
        } else {
            channel.ack(message);
            // console.log(`ack ${item.index._id}`);
        }
    });
}

function onResponse(resp, messageMap, callback, payloads, channel) {
    try {
        if (resp.errors) {
            ackOrNack(resp, messageMap, channel);
            return;
        }
        process.send({event: 'add_index', size: payloads.length});
        channel.ackAll();
    } finally {
        callback();
    }
}

function onError(err, callback, channel) {
    try {
        channel.nackAll();
        console.log('nack all', err.stack);
    } finally {
        callback();
    }
}

const routes = {
    'action': async (payloads, cb, ch) => {
        const messageMap = {};
        client['bulk']({
            index: queue_prefix + '-action',
            type: '_doc',
            body: buildActionBulk(payloads, messageMap)
        }).then(resp => {
            onResponse(resp, messageMap, cb, payloads, ch);
        }).catch(err => {
            onError(err, cb, ch);
        });
    },
    'transaction': async (payloads, cb, ch) => {
        const messageMap = {};
        client['bulk']({
            index: queue_prefix + '-transaction',
            type: '_doc',
            body: buildTransactionBulk(payloads, messageMap)
        }).then(resp => {
            onResponse(resp, messageMap, cb, payloads, ch);
        }).catch(err => {
            onError(err, cb, ch);
        });
    },
    'block': async (payloads, cb, ch) => {
        const messageMap = {};
        client['bulk']({
            index: queue_prefix + '-block',
            type: '_doc',
            body: buildBlockBulk(payloads, messageMap)
        }).then(resp => {
            onResponse(resp, messageMap, cb, payloads, ch);
        }).catch(err => {
            onError(err, cb, ch);
        });
    }
};

module.exports = {routes};
