const _ = require('lodash');
const crypto = require('crypto');

function makeScriptedOp(id, body) {
    return [
        {update: {_id: id, retry_on_conflict: 3}},
        {script: {id: "updateByBlock", params: body}, scripted_upsert: true, upsert: {}}
    ];
}

function buildActionBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(payload.content);
        const id = body['global_sequence'];
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    }).flatten()['value']();
}

function buildBlockBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(payload.content);
        const id = body['block_num'];
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    }).flatten()['value']();
}

function buildAbiBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(payload.content);
        const id = body['block'] + body['account'];
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    }).flatten()['value']();
}

function buildDeltaBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(payload.content);
        const id = `${body.block_num}-${body.code}-${body.scope}-${body.table}-${body.payer}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return [{index: {_id: id}}, body];
    }).flatten()['value']();
}

function buildTableProposalsBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(payload.content);
        const id = `${body.proposer}-${body.proposal_name}-${body.primary_key}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    }).flatten()['value']();
}

function buildTableAccountsBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(payload.content);
        const id = `${body.code}-${body.scope}-${body.primary_key}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    }).flatten()['value']();
}

function buildTableVotersBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(payload.content);
        const id = `${body.primary_key}`;
        messageMap.set(id, _.omit(payload, ['content']));
        return makeScriptedOp(id, body);
    }).flatten()['value']();
}


module.exports = {
    buildActionBulk,
    buildBlockBulk,
    buildDeltaBulk,
    buildAbiBulk,
    buildTableProposalsBulk,
    buildTableAccountsBulk,
    buildTableVotersBulk
};
