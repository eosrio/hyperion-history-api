const crypto = require('crypto');
const _ = require('lodash');

async function getCacheByHash(redis, key) {
    const hash = crypto.createHash('sha256');
    const query_hash = hash.update(process.env.CHAIN + "-" + key).digest('hex');
    return [await redis.get(query_hash), query_hash];
}

function mergeActionMeta(action) {
    const name = action.act.name;
    if (action['@' + name]) {
        action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
        if (name === 'transfer') {
            action.act.data.quantity = String(action.act.data.amount) + ' ' + action.act.data.symbol;
            delete action.act.data.amount;
            delete action.act.data.symbol;
        }
        delete action['@' + name];
    }
}

module.exports = {
    getCacheByHash,
    mergeActionMeta
};
