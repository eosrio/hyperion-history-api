import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {request as undiciRequest} from 'undici';

let logo: Buffer | null = null;
let contentType: string | null = null;

export function explorerLogoHandler(fastify: FastifyInstance, route: string) {
    return async (_: FastifyRequest, reply: FastifyReply) => {
        if (logo !== null && contentType !== null) {
            reply.header('Content-Type', contentType);
            reply.send(logo);
        } else {
            const {body, statusCode, headers} = await undiciRequest(fastify.manager.config.api.chain_logo_url);
            if (statusCode !== 200) {
                reply.code(statusCode).send({
                    error: 'Not Found',
                    message: 'The requested resource could not be found'
                });
            } else {
                logo = Buffer.from(await body.arrayBuffer());
                contentType = headers['content-type'] as string;
                reply.header('Content-Type', contentType);
                reply.send(logo);
            }
        }
    }
}
