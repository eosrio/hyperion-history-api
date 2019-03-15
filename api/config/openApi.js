exports.options = {
    routePrefix: '/v2/docs',
    exposeRoute: true,
    swagger: {
        info: {
            title: 'Hyperion History API',
            description: 'Scalable Full History API Solution for EOSIO based blockchains',
            version: '2.1.0'
        },
        host: process.env.SERVER_NAME,
        schemes: ['https','http'],
        consumes: ['application/json'],
        produces: ['application/json']
    }
};
