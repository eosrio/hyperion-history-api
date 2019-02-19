const _ = require('lodash');

function buildTransactionBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        messageMap[body.id] = payload;
        return [{
            index: {_id: body.id}
        }, {
            block_num: body.block_num,
            '@timestamp': body['@timestamp']
        }];
    }).flatten()['value']();
}

function buildActionBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        messageMap[body.receipt['global_sequence']] = payload;
        return [{
            index: {_id: body.receipt['global_sequence']}
        }, body];
    }).flatten()['value']();
}

function buildBlockBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        messageMap[body['block_num']] = payload;
        return [{
            index: {_id: body['block_num']}
        }, body];
    }).flatten()['value']();
}

module.exports = {
    buildActionBulk,
    buildBlockBulk,
    buildTransactionBulk
};
