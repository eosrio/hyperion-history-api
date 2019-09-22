const fp = require('fastify-plugin');
const {Api} = require("eosjs");
const {ConnectionManager} = require('../../connections/manager');
const manager = new ConnectionManager();

module.exports = fp(async (fastify, options, next) => {
    const rpc = manager.nodeosJsonRPC;
    const chain_data = await rpc.get_info();
    const api = new Api({
        rpc,
        signatureProvider: null,
        chainId: chain_data.chain_id,
        textDecoder: new TextDecoder(),
        textEncoder: new TextEncoder(),
    });
    fastify.decorate('eosjs', {api, rpc});
    next();
}, {
    fastify: '>=2.0.0',
    name: 'fastify-eosjs'
});
