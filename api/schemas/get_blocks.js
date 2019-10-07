exports.GET = {
    description: 'get block range',
    summary: 'get block range',
    tags: ['history'],
    querystring: {
        type: 'object',
        properties: {
            "from": {
                description: 'starting block',
                type: 'integer',
                minimum: 1
            },
            "to": {
                description: 'last block',
                type: 'integer',
                minimum: 1
            }
        }
    }
};
