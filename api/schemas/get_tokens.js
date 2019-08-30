exports.GET = {
    description: 'get tokens from account',
    summary: 'get tokens from account',
    tags: ['state'],
    querystring: {
        type: 'object',
        properties: {
            "account": {
                description: 'account',
                type: 'string'
            },
        },
        required: ["account"]
    },
    response: {
        200: {
            type: 'object',
            properties: {
                "query_time": {type: "number"},
                "cached": {type: "boolean"},
                "account": {type: "string"},
                "tokens": {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            "symbol": {type: "string"},
                            "precision": {type: "number"},
                            "amount": {type: "number"},
                            "contract": {type: "string"}
                        }
                    }
                }
            }
        }
    }
};
