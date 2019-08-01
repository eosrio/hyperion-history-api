exports.POST = {
    description: 'get all actions belonging to the same transaction',
    summary: 'get transaction by id',
    tags: ['history'],
    body: {
        type: ['object', 'string'],
        properties: {
            "id": {
                description: 'transaction id',
                type: 'string'
            }
        },
        required: ["id"]
    }
};
