import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timedQuery } from "../../../helpers/functions.js";

async function getExplorerMetadata(fastify: FastifyInstance) {



    return {
        provider: fastify.manager.config.api.provider_name,
        provider_url: fastify.manager.config.api.provider_url,
        chain_name: fastify.manager.config.api.chain_name,
        chain_id: fastify.manager.conn.chains[fastify.manager.chain].chain_id,
        custom_core_token: fastify.manager.config.api.custom_core_token,
        theme: fastify.explorerTheme ?? {},
        oracle: fastify.hasRoute({ url: '/v2/oracle/get_datapoints_histogram', method: 'GET' })
    }
}

export function explorerMetadataHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getExplorerMetadata, fastify, request, route));
    }
}
