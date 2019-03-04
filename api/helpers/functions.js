const crypto = require('crypto');

async function getCacheByHash(redis, key) {
    const hash = crypto.createHash('sha256');
    const query_hash = hash.update(process.env.CHAIN + "-" + key).digest('hex');
    return [await redis.get(query_hash), query_hash];
}

module.exports = {
    getCacheByHash
};
