exports.GET = {
    description: 'get account by public key',
    summary: 'get account by public key',
    querystring: {
        type: 'object',
        properties: {
            "public_key": {
                description: 'public key',
                type: 'string'
            },
        },
        required: ["public_key"]
    }
};
