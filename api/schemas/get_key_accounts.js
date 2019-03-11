exports.GET = {
    description: 'get account by public key',
    summary: 'get account by public key',
    tags: ['state'],
    querystring: {
        type: 'object',
        properties: {
            "public_key": {
                description: 'public key',
                type: 'string'
            },
        },
        required: ["public_key"]
    },
    response: {
        200: {
            type: 'object',
            properties: {
                "account_names": {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            }
        }
    }
};
