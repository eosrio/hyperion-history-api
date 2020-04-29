import {FastifyInstance} from "fastify";
import {addApiRoute, chainApiHandler, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    addApiRoute(
        fastify,
        'POST',
        getRouteName(__filename),
        chainApiHandler,
        {
            description: "This method expects a transaction in JSON format and will attempt to apply it to the blockchain.",
            summary: "This method expects a transaction in JSON format and will attempt to apply it to the blockchain.",
            tags: ['chain'],
            body: {
                type: ['array', 'object', 'string'],
                items: {
                    type: ['object', 'string'],
                    additionalProperties: false,
                    minProperties: 8,
                    required: [
                        "expiration",
                        "ref_block_num",
                        "ref_block_prefix",
                        "max_net_usage_words",
                        "max_cpu_usage_ms",
                        "delay_sec",
                        "context_free_actions",
                        "actions"
                    ],
                    properties: {
                        "expiration": 'Expiration#',
                        "ref_block_num": {"type": "integer"},
                        "ref_block_prefix": {"type": "integer"},
                        "max_net_usage_words": 'WholeNumber#',
                        "max_cpu_usage_ms": 'WholeNumber#',
                        "delay_sec": {"type": "integer"},
                        "context_free_actions": {"type": "array", "items": 'ActionItems#'},
                        "actions": {"type": "array", "items": 'ActionItems#'},
                        "transaction_extensions": {"type": "array", "items": 'BlockExtensions#'}
                    },
                }
            }
        }
    );
    next();
}
