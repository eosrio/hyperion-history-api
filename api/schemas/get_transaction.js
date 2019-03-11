exports.GET = {
    description: 'get all actions belonging to the same transaction',
    summary: 'get transaction by id',
    tags: ['history'],
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
