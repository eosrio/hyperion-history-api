exports.GET = {
    description: 'get actions based on notified account. this endpoint also accepts generic filters based on indexed fields' +
        ' (e.g. act.authorization.actor=eosio or act.name=delegatebw), if included they will be combined with a AND operator',
    summary: 'get root actions',
    tags: ['v2'],
    querystring: {
        type: 'object',
        properties: {
            "account": {
                description: 'notified account',
                type: 'string',
                minLength: 1,
                maxLength: 12
            },
            "filter": {
                description: 'code::name filter',
                type: 'string',
                minLength: 3
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
            }
        }
    },
    response: {
        200: {
            type: 'object',
            properties: {
                "query_time": {
                    type: "number"
                },
                "lib": {
                    type: "number"
                },
                "actions": {
                    type: "array",
                    items: {
                        type: 'object',
                        properties: {
                            "act": {
                                type: 'object',
                                properties: {
                                    "account": {type: "string"},
                                    "name": {type: "string"}
                                },
                                additionalProperties: true
                            },
                            "@timestamp": {type: "string"},
                            "block_num": {type: "number"},
                            "producer": {type: "string"},
                            "trx_id": {type: "string"},
                            "parent": {type: "number"},
                            "global_sequence": {type: "number"},
                            "notified": {type: "array", items: {type: "string"}}
                        }
                    }
                }
            }
        }
    }
};
