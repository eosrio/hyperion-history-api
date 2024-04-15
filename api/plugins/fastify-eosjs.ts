import {FastifyInstance, FastifyPluginOptions} from "fastify";
import {Api} from "eosjs/dist";
import fp from "fastify-plugin";
import {SignatureProvider} from "../../addons/eosjs-native/eosjs-api-interfaces";
import {JsSignatureProvider} from "../../addons/eosjs-native/eosjs-jssig";

export default fp(async (fastify: FastifyInstance, options: FastifyPluginOptions): Promise<void> => {
    const sigProvider = new JsSignatureProvider([]);
    const rpc = fastify.manager.nodeosJsonRPC;
    const api = new Api({
        rpc,
        signatureProvider: sigProvider,
        chainId: options.chain_id,
        textDecoder: new TextDecoder(),
        textEncoder: new TextEncoder(),
    });
    fastify.decorate('eosjs', {api, rpc});
}, {
    fastify: '>=2.0.0',
    name: 'fastify-eosjs'
});
