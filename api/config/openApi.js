const packageData = require('../../package');

exports.options = {
    routePrefix: '/v2/docs',
    exposeRoute: true,
    swagger: {
        info: {
            title: 'Hyperion History API',
            description: 'Scalable Full History API Solution for EOSIO based blockchains',
            version: packageData.version
        },
        host: process.env.SERVER_NAME,
        schemes: ['https', 'http'],
        consumes: ['application/json'],
        produces: ['application/json']
    }
};
