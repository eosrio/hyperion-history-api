exports.GET = {
    description: 'fetch contract abi at specific block',
    summary: 'fetch abi at specific block',
    tags: ['history'],
    querystring: {
        type: 'object',
        properties: {
            "contract": {
                description: 'contract account',
                type: 'string',
                minLength: 1,
                maxLength: 12
            },
            "block": {
                description: 'target block',
                type: 'integer',
                minimum: 1
            },
            "fetch": {
                description: 'should fetch the ABI',
                type: 'boolean'
            }
        },
        required: ["contract"]
    }
};
