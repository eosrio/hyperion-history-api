const packageData = require('../../package');

const health_link = `https://${process.env.SERVER_NAME}/v2/health`;
const description = `
<img height="64" src="https://eosrio.io/hyperion.png">
### Scalable Full History API Solution for EOSIO based blockchains
*Made with ♥️ by [EOS Rio](https://eosrio.io/)*
***
#### Current Chain: ${process.env.CHAIN_NAME} <img style="transform: translateY(8px)" height="32" src="${process.env.CHAIN_LOGO_URL}">
#### Provided by [${process.env.PROVIDER_NAME}](${process.env.PROVIDER_URL})
#### Health API: <a target="_blank" href="${health_link}">${health_link}</a>
`;

exports.options = {
    routePrefix: '/v2/docs',
    exposeRoute: true,
    swagger: {
        info: {
            title: `Hyperion History API for ${process.env.CHAIN_NAME}`,
            description: description,
            version: packageData.version
        },
        host: process.env.SERVER_NAME,
        schemes: ['https', 'http'],
        consumes: ['application/json'],
        produces: ['application/json']
    }
};
