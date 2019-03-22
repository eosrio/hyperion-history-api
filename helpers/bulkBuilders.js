const _ = require('lodash');
const crypto = require('crypto');

function buildActionBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        messageMap.set(body['global_sequence'], payload);
        return [{
            index: {_id: body['global_sequence']}
        }, body];
    }).flatten()['value']();
}

function buildBlockBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        messageMap.set(body['block_num'], payload);
        return [{
            index: {_id: body['block_num']}
        }, body];
    }).flatten()['value']();
}

function buildAbiBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id = body['block'] + body['account'];
        messageMap.set(id, payload);
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
        messageMap.set(id, payload);
        return [
            {index: {_id: id}},
            body
        ];
    }).flatten()['value']();
}

function buildTableAccountsBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id_string = `${body.code}-${body.scope}-${body.primary_key}`;
        const hash = crypto.createHash('sha256');
        const id = hash.update(id_string).digest('hex');
        messageMap.set(id, payload);
        return [
            {update: {_id: id, retry_on_conflict: 3}},
            {
                script: {
                    id: "updateByBlock",
                    params: body
                },
                scripted_upsert: true,
                upsert: {}
            }
        ];
    }).flatten()['value']();
}

function buildTableVotersBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id_string = `${body.primary_key}`;
        const hash = crypto.createHash('sha256');
        const id = hash.update(id_string).digest('hex');
        messageMap.set(id, payload);
        console.log(body);
        return [
            {update: {_id: id, retry_on_conflict: 3}},
            {
                script: {
                    id: "updateByBlock",
                    params: body
                },
                scripted_upsert: true,
                upsert: {}
            }
        ];
    }).flatten()['value']();
}


module.exports = {
    buildActionBulk,
    buildBlockBulk,
    buildDeltaBulk,
    buildAbiBulk,
    buildTableAccountsBulk,
    buildTableVotersBulk
};
