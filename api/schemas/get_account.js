exports.GET = {
    description: 'get account data',
    summary: 'get account summary',
    tags: ['accounts', 'state'],
    querystring: {
        type: 'object',
        properties: {
            "account": {
                description: 'account name',
                type: 'string'
            }
        }
    }
};
