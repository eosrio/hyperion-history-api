import {FastifyInstance} from "fastify";
import {getProposalsHandler} from "./get_proposals.js";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get proposals',
        summary: 'get proposals',
        tags: ['system'],
        querystring: {
            type: 'object',
            properties: {
                "proposer": {
                    description: 'filter by proposer',
                    type: 'string'
                },
                "proposal": {
                    description: 'filter by proposal name',
                    type: 'string'
                },
                "account": {
                    description: 'filter by either requested or provided account',
                    type: 'string'
                },
                "requested": {
                    description: 'filter by requested account',
                    type: 'string'
                },
                "provided": {
                    description: 'filter by provided account',
                    type: 'string'
                },
                "executed": {
                    description: 'filter by execution status',
                    type: 'boolean'
                },
                "track": {
                    description: 'total results to track (count) [number or true]',
                    type: 'string'
                },
                "skip": {
                    description: 'skip [n] actions (pagination)',
                    type: 'integer',
                    minimum: 0
                },
                "limit": {
                    description: 'limit of [n] actions per page',
                    type: 'integer',
                    minimum: 1
                }
            }
        },
        response: extendResponseSchema({
            total: {
                type: "object",
                properties: {
                    value: {type: "number"},
                    relation: {type: "string"}
                }
            },
            proposals: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        proposal_name: { type: "string" },
                        expiration: { type: "string" },
                        earliest_exec_time: { type: "string", nullable: true },
                        block_num: { type: "number" },
                        proposer: { type: "string" },
                        executed: { type: "boolean" },
                        primary_key: { type: "string" },
                        trx: {
                            type: "object",
                            properties: {
                                expiration: { type: "string" },
                                ref_block_num: { type: "number" },
                                ref_block_prefix: { type: "number" },
                                max_net_usage_words: { type: "number" },
                                max_cpu_usage_ms: { type: "number" },
                                delay_sec: { type: "number" },
                                context_free_actions: { type: "array", items: { type: "object" } },
                                actions: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            account: { type: "string" },
                                            name: { type: "string" },
                                            authorization: {
                                                type: "array",
                                                items: {
                                                    type: "object",
                                                    properties: {
                                                        actor: { type: "string" },
                                                        permission: { type: "string" }
                                                    }
                                                }
                                            },
                                            data: {
                                                type: "object",
                                                properties: {
                                                    from: { type: "string" },
                                                    to: { type: "string" },
                                                    quantity: { type: "string" },
                                                    memo: { type: "string" }
                                                }
                                            }
                                        }
                                    }
                                },
                                transaction_extensions: { type: "array", items: { type: "object" } }
                            }
                        },
                        requested_approvals: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    actor: { type: "string" },
                                    permission: { type: "string" },
                                    time: { type: "string" }
                                }
                            }
                        },
                        provided_approvals: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    actor: { type: "string" },
                                    permission: { type: "string" },
                                    time: { type: "string" }
                                }
                            }
                        }
                    }
                }
            }
        })
    };

    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        getProposalsHandler,
        schema
    );
    next();
}
