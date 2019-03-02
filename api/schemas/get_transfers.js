exports.GET = {
    description: 'get token transfers utilizing the eosio.token standard',
    summary: 'get token transfers',
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
    }
};
