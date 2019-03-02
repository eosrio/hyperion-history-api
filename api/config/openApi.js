exports.options = {
    routePrefix: '/v2/history/docs',
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
        host: 'br.eosrio.io',
        schemes: ['https'],
        consumes: ['application/json'],
        produces: ['application/json']
    }
};
