module.exports = {
    GET: {
        description: 'get accounts by public key',
        summary: 'get accounts by public key',
        tags: ['accounts','state'],
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
    },
    POST: {
        description: 'get accounts by public key',
        summary: 'get accounts by public key',
        tags: ['accounts','state'],
        body: {
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
    }
};
