const _ = require('lodash');
const crypto = require('crypto');

function buildActionBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
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

function buildTableAccountsBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id_string = `${body.code}-${body.scope}-${body.primary_key}`;
        const hash = crypto.createHash('sha256');
        const id = hash.update(id_string).digest('hex');
        messageMap[id] = payload;
        return [
            {update: {_id: id}},
            {
                "script": {
                    "id": "update_accounts",
                    "params": {
                        "block_num": body['block_num'],
                        "amount": body['amount']
                    }
                },
                "upsert": body
            }
        ];
    }).flatten()['value']();
}

function buildTableVotersBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id = body.primary_key;
        messageMap[id] = payload;
        return [
            {update: {_id: id}},
            {
                "script": {
                    "id": "update_accounts",
                    "params": {
                        "block_num": body['block_num'],
                        "is_proxy": body['is_proxy'],
                        "proxy": body['proxy'],
                        "producers": body['producers'],
                        "last_vote_weight": body['last_vote_weight'],
                        "proxied_vote_weight": body['proxied_vote_weight'],
                        "staked": body['staked']
                    }
                },
                "upsert": body
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
