exports.GET = {
    description: 'get account creator',
    summary: 'get account creator',
    tags: ['history'],
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
    },
    response: {
        200: {
            type: 'object',
            properties: {
                "account": {
                    type: "string"
                },
                "creator": {
                    type: "string"
                },
                "timestamp": {
                    type: "string"
                },
                "trx_id": {
                    type: "string"
                },
                "indirect_creator": {
                    type: "string"
                }
            }
        }
    }
};
