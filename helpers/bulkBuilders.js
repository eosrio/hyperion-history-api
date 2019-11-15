const _ = require('lodash');
const crypto = require('crypto');

function makeScriptedOp(id, body) {
    return [
        {update: {_id: id, retry_on_conflict: 3}},
        {script: {id: "updateByBlock", params: body}, scripted_upsert: true, upsert: {}}
    ];
}

function makeHashedId(id_string) {
    const hash = crypto.createHash('sha256');
    return hash.update(id_string).digest('hex');
}

function buildActionBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        messageMap.set(body['global_sequence'], payload);
        return [{index: {_id: body['global_sequence']}}, body];
    }).flatten()['value']();
}

function buildBlockBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        messageMap.set(body['block_num'], payload);
        return [{index: {_id: body['block_num']}}, body];
    }).flatten()['value']();
}

function buildAbiBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id = body['block'] + body['account'];
        messageMap.set(id, payload);
        return [{index: {_id: id}}, body];
    }).flatten()['value']();
}

function buildDeltaBulk(payloads, messageMap) {
    return _(payloads).map(payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id = makeHashedId(`${body.block_num}-${body.code}-${body.scope}-${body.table}-${body.payer}`);
        messageMap.set(id, payload);
        return [{index: {_id: id}}, body];
    }).flatten()['value']();
}

function buildTableProposalsBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id = makeHashedId(`${body.proposer}-${body.proposal_name}-${body.primary_key}`);
        messageMap.set(id, payload);
        return makeScriptedOp(id, body);
    }).flatten()['value']();
}

function buildTableAccountsBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id = makeHashedId(`${body.code}-${body.scope}-${body.primary_key}`);
        messageMap.set(id, payload);
        return makeScriptedOp(id, body);
    }).flatten()['value']();
}

function buildTableVotersBulk(payloads, messageMap) {
    return _(payloads)['map'](payload => {
        const body = JSON.parse(Buffer.from(payload.content).toString());
        const id = makeHashedId(`${body.primary_key}`);
        messageMap.set(id, payload);
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
