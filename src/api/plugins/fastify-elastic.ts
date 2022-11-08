import {FastifyInstance, FastifyPluginOptions} from "fastify";
import {default as FP} from "fastify-plugin";
import {Client} from "@elastic/elasticsearch";

export default FP.default(async (fastify: FastifyInstance, options: FastifyPluginOptions): Promise<void> => {
    const {healthcheck} = options
    delete options.namespace
    delete options.healthcheck
    const client = options.client || new Client(options)
    if (healthcheck !== false) {
        await client.ping()
    }
    fastify.decorate('elastic', client);
    fastify.addHook('onClose', async (instance: FastifyInstance) => {
        await instance.elastic.close();
    });
}, {
    fastify: '4.x',
    name: 'fastify-elastic'
});
