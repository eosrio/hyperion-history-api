exports.GET = {
    description: 'get state deltas',
    summary: 'get state deltas',
    tags: ['history'],
    querystring: {
        type: 'object',
        properties: {
            "code": {
                description: 'contract account',
                type: 'string'
            },
            "scope": {
                description: 'table scope',
                type: 'string'
            },
            "table": {
                description: 'table name',
                type: 'string'
            },
            "payer": {
                description: 'payer account',
                type: 'string'
            }
        }
    }
};
