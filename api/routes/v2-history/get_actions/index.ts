import {FastifyInstance, RouteSchema} from "fastify";
import {getActionsHandler} from "./get_actions";
import {addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName} from "../../../helpers/functions";

export const getActionResponseSchema = {
    "@timestamp": {type: "string"},
    "timestamp": {type: "string"},
    "block_num": {type: "number"},
    "trx_id": {type: "string"},
    "act": {
        type: 'object',
        properties: {
            "account": {type: "string"},
            "name": {type: "string"}
        },
        additionalProperties: true
    },
    "notified": {
        type: "array", items: {type: "string"}
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
    "receiver": {type: 'string'},
    "producer": {type: "string"},
    "parent": {type: "number"},
    "action_ordinal": {type: 'number'},
    "creator_action_ordinal": {type: 'number'}
};

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: RouteSchema = {
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
        getRouteName(__filename),
        getActionsHandler,
        schema
    );
    next();
}
