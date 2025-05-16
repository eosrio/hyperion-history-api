import fp from "fastify-plugin";
import {APIClient} from "@wharfkit/antelope";
import {FastifyInstance, FastifyPluginOptions} from "fastify";
import {ConnectionManager} from "../../indexer/connections/manager.class.js";
import {hLog} from "../../indexer/helpers/common_functions.js";

export default fp(async (fastify: FastifyInstance, options: FastifyPluginOptions): Promise<void> => {
    const manager = options.manager as ConnectionManager;
    const api = new APIClient({url: manager.conn.chains[manager.chain].http, fetch});

    const getHeadBlockNum = async (): Promise<number | undefined> => {
        try {
            return (await api.v1.chain.get_info()).head_block_num.toNumber();
        } catch (e: any) {
            hLog(`[Antelope ChainAPI] Failed to get head block number: ${e.message}`);
            return;
        }
    }

    fastify.decorate('antelope', {
        chain: api.v1.chain,
        getHeadBlockNum
    });
}, {
    fastify: '5.x',
    name: 'fastify-antelope'
});