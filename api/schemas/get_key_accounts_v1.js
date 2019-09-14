exports.POST = {
    description: 'get accounts by public key',
    summary: 'get accounts by public key',
    tags: ['state'],
    body: {
        type: ['object','string'],
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
