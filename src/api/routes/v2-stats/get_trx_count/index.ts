import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import { getTrxCountHandler } from "./get_trx_count.js";


export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: FastifySchema = {
        description: 'get transaction count statistics from block range',
        summary: 'get transaction count statistics from block range',
        tags: ['stats'],
        querystring: {
            type: 'object',
            properties: {
                "start_block": {
                    description: 'start block number (inclusive)',
                    type: 'integer',
                    minimum: 1
                },
                "end_block": {
                    description: 'end block number (inclusive)',
                    type: 'integer',
                    minimum: 1
                },
                "after": {
                    description: 'filter after specified date (ISO8601)',
                    type: 'string'
                },
                "before": {
                    description: 'filter before specified date (ISO8601)',
                    type: 'string'
                },
                "producer": {
                    description: 'filter by specific producer',
                    type: 'string'
                },
                "group_by": {
                    description: 'group results by field (producer, hour, day)',
                    type: 'string',
                    enum: ['producer', 'hour', 'day']
                },
                "validate_actions": {
                    description: 'validate transaction count against action count to detect missing actions (excludes eosio::onblock system actions)',
                    type: 'boolean'
                }
            }
        },
        response: extendResponseSchema({
            "total_trx_count": {
                type: "integer",
                description: "Total transaction count in the range"
            },
            "block_count": {
                type: "integer",
                description: "Number of blocks in the range"
            },
            "avg_trx_per_block": {
                type: "number",
                description: "Average transactions per block"
            },
            "start_block": {
                type: "integer"
            },
            "end_block": {
                type: "integer"
            },
            "grouped_stats": {
                type: "object",
                description: "Statistics grouped by specified field",
                additionalProperties: true
            },
            "validation": {
                type: "object",
                description: "Validation results when validate_actions is true",
                properties: {
                    "total_action_count": {
                        type: "integer",
                        description: "Total actions found in action index (excluding eosio::onblock system actions)"
                    },
                    "transaction_count_from_blocks": {
                        type: "integer",
                        description: "Total transaction count from block index"
                    },
                    "is_valid": {
                        type: "boolean",
                        description: "Whether action count matches transaction count"
                    },
                    "missing_actions": {
                        type: "integer",
                        description: "Number of missing actions (negative if excess actions)"
                    }
                }
            }
        })
    };
    addApiRoute(fastify, 'GET', getRouteName(import.meta.filename), getTrxCountHandler, schema);
    next();
}
