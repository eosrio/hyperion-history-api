import * as fp from 'fastify-plugin';
import {FastifyInstance} from "fastify";
import {Api} from "eosjs/dist";

export default fp(async (fastify: FastifyInstance, options, next) => {
    const rpc = fastify.manager.nodeosJsonRPC;
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
