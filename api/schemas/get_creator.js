exports.GET = {
    description: 'get account creator',
    summary: 'get account creator',
    querystring: {
        type: 'object',
        properties: {
            "account": {
                description: 'created account',
                type: 'string',
                minLength: 1,
                maxLength: 12
            }
        }
    }
};
