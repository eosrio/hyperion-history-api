import { FastifyInstance } from 'fastify';
import { HyperionDelta, HyperionDeltaHandler, HyperionPlugin } from './hyperion-plugin.js';

export interface DelphioracleConfig {
    table?: string;
    contract?: string;
}

export default class DelphioraclePlugin extends HyperionPlugin {

    apiPlugin = true;
    hasApiRoutes = true;
    deltaHandlers: HyperionDeltaHandler[] = [];

    addRoutes(server: FastifyInstance): void {
        server.get('/v2/history/get_oracle_datapoints', async (request, reply) => {
            reply.send({ message: 'Delphioracle API is running!' });
        });
    }


    constructor(config: DelphioracleConfig) {
        super(config);
        console.log('DelphioraclePlugin initialized with config:', config);
        const tableName = config.table || 'datapoints';

        const mappings = {
            delta: {}
        };

        mappings.delta["@" + tableName] = {
            properties: {
                value: { type: "long" },
                owner: { type: "keyword" },
                median: { type: "long" }
            }
        };

        this.deltaHandlers.push({
            table: tableName,
            contract: config.contract || 'delphioracle',
            mappings,
            handler: async (delta: HyperionDelta) => {
                const data = delta['data'];
                if (data['value'] && data['median'] && data['owner']) {
                    delta["@" + tableName] = {
                        owner: data['owner'],
                        value: data['value'],
                        median: data['median']
                    };
                    delete delta['data'];
                }
                console.log(delta);
            },
        });
    }
}