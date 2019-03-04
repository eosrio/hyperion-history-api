exports.GET = {
    description: 'get all actions belonging to the same transaction',
    summary: 'get transaction by id',
    tags: ['v2'],
    querystring: {
        type: 'object',
        properties: {
            "id": {
                description: 'transaction id',
                type: 'string'
            }
        },
        required: ["id"]
    }
};
