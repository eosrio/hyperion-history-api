const _ = require('lodash');
const crypto = require('crypto');

function buildActionBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        console.log(body);
        messageMap[body['global_sequence']] = payload;
        return [{
            index: {_id: body['global_sequence']}
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

function buildAbiBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id = body['block'] + body['account'];
        messageMap[id] = payload;
        return [
            {index: {_id: id}},
            body
        ];
    }).flatten()['value']();
}

function buildDeltaBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id_string = `${body.block_num}-${body.code}-${body.scope}-${body.table}-${body.payer}`;
        const hash = crypto.createHash('sha256');
        const id = hash.update(id_string).digest('hex');
        messageMap[id] = payload;
        return [
            {index: {_id: id}},
            body
        ];
    }).flatten()['value']();
}

module.exports = {
    buildActionBulk,
    buildBlockBulk,
    buildDeltaBulk,
    buildAbiBulk
};
