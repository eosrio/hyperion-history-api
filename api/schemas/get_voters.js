exports.GET = {
    description: 'get voters',
    summary: 'get voters',
    tags: ['state'],
    querystring: {
        type: 'object',
        properties: {
            "producer": {
                description: 'filter by voted producer (comma separated)',
                type: 'string'
            },
            "skip": {
                description: 'skip [n] actions (pagination)',
                type: 'integer',
                minimum: 0
            },
            "limit": {
                description: 'limit of [n] actions per page',
                type: 'integer',
                minimum: 1
            }
        }
    }
};
