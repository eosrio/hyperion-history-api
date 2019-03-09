exports.GET = {
    description: 'get all account that interacted with the source account provided',
    summary: 'get interactions based on transfers',
    tags: ['v2'],
    querystring: {
        type: 'object',
        properties: {
            "account": {
                description: 'source account',
                type: 'string'
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
            "direction": {
                description: 'search direction',
                enum: ['in', 'out', 'both'],
                type: 'string'
            },
            "min": {
                description: 'minimum value',
                type: 'number'
            },
            "max": {
                description: 'maximum value',
                type: 'number'
            },
            "limit": {
                description: 'query limit',
                type: 'number'
            },
            "after": {
                description: 'filter after specified date (ISO8601) or block number',
                type: 'string'
            },
            "before": {
                description: 'filter before specified date (ISO8601) or block number',
                type: 'string'
            }
        },
        required: ["account", "direction"]
    }
};
