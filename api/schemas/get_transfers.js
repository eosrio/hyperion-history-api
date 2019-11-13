exports.GET = {
    description: 'get token transfers utilizing the ' + process.env.SYSTEM_DOMAIN + '.token standard',
    summary: 'get token transfers',
    tags: ['history'],
    querystring: {
        type: 'object',
        properties: {
            "from": {
                description: 'source account',
                type: 'string',
                minLength: 1,
                maxLength: 12
            },
            "to": {
                description: 'destination account',
                type: 'string',
                minLength: 1,
                maxLength: 12
            },
            "symbol": {
                description: 'token symbol',
                type: 'string',
                minLength: 1,
                maxLength: 7
            },
            "contract": {
                description: 'token contract',
                type: 'string',
                minLength: 1,
                maxLength: 12
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
        },
        "anyOf": [
            {required: ["from"]},
            {required: ["to"]},
            {required: ["symbol"]},
            {required: ["contract"]}
        ]
    },
    response: {
        200: {
            type: 'object',
            properties: {
                "action_count": {
                    type: "number"
                },
                "total_amount": {
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
