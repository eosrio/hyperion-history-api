exports.POST = {
    description: 'get controlled accounts by controlling accounts',
    summary: 'get controlled accounts by controlling accounts',
    tags: ['state'],
    body: {
        type: ['object','string'],
        properties: {
            "controlling_account": {
                description: 'controlling account',
                type: 'string'
            },
        },
        required: ["controlling_account"]
    },
    response: {
        200: {
            type: 'object',
            properties: {
                "controlled_accounts": {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            }
        }
    }
};
