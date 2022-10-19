import { Api } from "enf-eosjs";
import { default as FP } from "fastify-plugin";
import { JsSignatureProvider } from "enf-eosjs/dist/eosjs-jssig.js";
export default FP.default(async (fastify, options) => {
    const rpc = fastify.manager.nodeosJsonRPC;
    const chain_data = await rpc.get_info();
    const api = new Api({
        rpc,
        signatureProvider: new JsSignatureProvider([]),
        chainId: chain_data.chain_id,
        textDecoder: new TextDecoder(),
        textEncoder: new TextEncoder(),
    });
    fastify.decorate('eosjs', { api, rpc });
}, {
    fastify: '4.x',
    name: 'fastify-eosjs'
});
