exports.options = {
    routePrefix: '/v2/docs',
    exposeRoute: true,
    swagger: {
        info: {
            title: 'Hyperion History API',
            description: 'Scalable Full History API Solution for EOSIO based blockchain',
            version: '2.0.0'
        },
        externalDocs: {
            url: 'http://docs.hyperion.eosrio.io/',
            description: 'Detailed reference'
        },
        host: process.env.SERVER_NAME,
        schemes: ['https'],
        consumes: ['application/json'],
        produces: ['application/json']
    }
};
