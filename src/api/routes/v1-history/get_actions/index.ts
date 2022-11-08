import {FastifyInstance} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions.js";
import {getActionsHandler} from "./get_actions.js";

export default function (fastify: FastifyInstance, opts: any, next: (err?: Error) => void) {

    // POST
    addApiRoute(fastify, 'POST', getRouteName(import.meta.url), getActionsHandler, {
        description: 'legacy get actions query',
        summary: 'get actions',
        tags: ['history'],
        body: {
            anyOf: [
                {
                    type: 'string'
                },
                {
                    type: 'object',
                    properties: {
                        "account_name": {
                            description: 'notified account',
                            type: 'string',
                            minLength: 1,
                            maxLength: 12
                        },
                        "pos": {
                            description: 'action position (pagination)',
                            type: 'integer'
                        },
                        "offset": {
                            description: 'limit of [n] actions per page',
                            type: 'integer'
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
                            type: 'string',
                            format: 'date-time'
                        },
                        "before": {
                            description: 'filter before specified date (ISO8601)',
                            type: 'string',
                            format: 'date-time'
                        },
                        "parent": {
                            description: 'filter by parent global sequence',
                            type: 'integer',
                            minimum: 0
                        }
                    }
                }
            ],
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    query_time: {type: 'number'},
                    last_irreversible_block: {type: 'number'},
                    actions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                account_action_seq: {type: 'number'},
                                global_action_seq: {type: 'number'},
                                block_num: {type: 'number'},
                                block_time: {type: 'string'},
                                action_trace: {
                                    type: 'object',
                                    properties: {
                                        action_ordinal: {type: 'number'},
                                        creator_action_ordinal: {type: 'number'},
                                        receipt: {
                                            type: 'object',
                                            properties: {
                                                receiver: {type: 'string'},
                                                global_sequence: {type: 'number'},
                                                recv_sequence: {type: 'number'},
                                                auth_sequence: {
                                                    type: 'array',
                                                    items: {
                                                        type: 'object',
                                                        properties: {
                                                            account: {type: 'string'},
                                                            sequence: {type: 'number'}
                                                        }
                                                    }
                                                }
                                            }
                                        },
                                        receiver: {type: 'string'},
                                        act: {
                                            type: 'object',
                                            properties: {
                                                account: {type: 'string'},
                                                name: {type: 'string'},
                                                authorization: {
                                                    type: 'array',
                                                    items: {
                                                        type: 'object',
                                                        additionalProperties: true,
                                                    }
                                                },
                                                data: {type: 'object', additionalProperties: true},
                                                hex_data: {type: 'string'}
                                            }
                                        },
                                        trx_id: {type: 'string'},
                                        block_num: {type: 'number'},
                                        block_time: {type: 'string'}
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });
    next();
}
