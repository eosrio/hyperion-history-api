import {FastifyInstance, FastifySchema} from "fastify";
import {getActionsHandler} from "./get_actions.js";
import {addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";

export const getActionResponseSchema = {
    "@timestamp": {type: "string"},
    "timestamp": {type: "string"},
    "block_num": {type: "number"},
    "block_id": {type: "string"},
    "trx_id": {type: "string"},
    "act": {
        type: 'object',
        properties: {
            "account": {type: "string"},
            "name": {type: "string"},
            "authorization": {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        "actor": {type: "string"},
                        "permission": {type: "string"},
                    }
                }
            }
        },
        additionalProperties: true
    },
    "receipts": {
        type: "array",
        items: {
            type: "object",
            properties: {
                "receiver": {type: "string"},
                "global_sequence": {type: "number"},
                "recv_sequence": {type: "number"},
                "auth_sequence": {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            "account": {type: "string"},
                            "sequence": {type: "number"},
                        }
                    }
                }
            }
        }
    },
    "cpu_usage_us": {type: "number"},
    "net_usage_words": {type: "number"},
    "account_ram_deltas": {
        type: "array",
        items: {
            type: "object",
            properties: {
                "account": {type: "string"},
                "delta": {type: "number"}
            },
            additionalProperties: true
        }
    },
    "global_sequence": {type: "number"},
    "producer": {type: "string"},
    "parent": {type: "number"},
    "action_ordinal": {type: 'number'},
    "creator_action_ordinal": {type: 'number'},
    "signatures": {type: "array", items: {type: 'string'}}
};

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: FastifySchema = {
        description: 'get actions based on notified account. this endpoint also accepts generic filters based on indexed fields' +
            ' (e.g. act.authorization.actor=eosio or act.name=delegatebw), if included they will be combined with a AND operator',
        summary: 'get root actions',
        tags: ['history'],
        querystring: extendQueryStringSchema({
            "account": {
                description: 'notified account',
                type: 'string',
                minLength: 1,
                maxLength: 12
            },
            "track": {
                description: 'total results to track (count) [number or true]',
                type: 'string'
            },
            "filter": {
                description: 'code:name filter',
                type: 'string',
                minLength: 3
            },
            "sort": {
                description: 'sort direction',
                enum: ['desc', 'asc', '1', '-1'],
                type: 'string'
            },
            "after": {
                description: 'filter after specified date (ISO8601)',
                type: 'string'
            },
            "before": {
                description: 'filter before specified date (ISO8601)',
                type: 'string'
            },
            "simple": {
                description: 'simplified output mode',
                type: 'boolean'
            },
            "hot_only": {
                description: 'search only the latest hot index',
                type: 'boolean'
            },
            "noBinary": {
                description: "exclude large binary data",
                type: 'boolean'
            },
            "checkLib": {
                description: "perform reversibility check",
                type: 'boolean'
            },
        }),
        response: extendResponseSchema({
            "simple_actions": {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        "block": {type: "number"},
                        "timestamp": {type: "string"},
                        "irreversible": {type: "boolean"},
                        "contract": {type: "string"},
                        "action": {type: "string"},
                        "actors": {type: "string"},
                        "notified": {type: "string"},
                        "transaction_id": {type: "string"},
                        "data": {
                            additionalProperties: true
                        }
                    }
                }
            },
            "actions": {
                type: "array",
                items: {
                    type: 'object',
                    properties: getActionResponseSchema
                }
            }
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        getActionsHandler,
        schema
    );
    next();
}
