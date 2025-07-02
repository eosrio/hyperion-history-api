import fp from "fastify-plugin";
import {APIClient} from "@wharfkit/antelope";
import {FastifyInstance, FastifyPluginOptions} from "fastify";
import {ConnectionManager} from "../../indexer/connections/manager.class.js";
import {hLog} from "../../indexer/helpers/common_functions.js";
import {SavedAbi} from "../../interfaces/hyperion-abi.js";

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

    const getAbi = async (account: string): Promise<SavedAbi | undefined> => {
        try {
            const abi = await api.v1.chain.get_abi(account);
            if (abi.abi) {
                return {
                    abi: abi.abi,
                    valid_until: null,
                    valid_from: null
                };
            }
        } catch (e: any) {
            hLog(`[Antelope ChainAPI] Failed to get ABI for account ${account}: ${e.message}`);
            return;
        }
    }

    const getAccountUntyped = async (account: string): Promise<any | undefined> => {
        try {
            const response = await api.call({
                path: "/v1/chain/get_account",
                params: {
                    account_name: account,
                },
            });
            if (response) {
                return response;
            }
        } catch (e: any) {
            hLog(`[Antelope ChainAPI] Failed to get account ${account}: ${e.message}`);
            return;
        }
    }

    fastify.decorate('antelope', {
        chain: api.v1.chain,
        getHeadBlockNum,
        getAbi,
        getAccountUntyped
    });
}, {
    fastify: '5.x',
    name: 'fastify-antelope'
});
