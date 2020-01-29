const crypto = require('crypto');
const _ = require('lodash');

async function getCacheByHash(redis, key) {
    const hash = crypto.createHash('sha256');
    const query_hash = hash.update(process.env.CHAIN + "-" + key).digest('hex');
    return [await redis.get(query_hash), query_hash];
}

function mergeActionMeta(action) {
    
    action['notified'] = action['notified'].map((a) => {
        return a.split(",")[0];
    });
    
    const name = action.act.name;
    if (action['@' + name]) {
        action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
        delete action['@' + name];
    }
}

module.exports = {
    getCacheByHash,
    mergeActionMeta
};
