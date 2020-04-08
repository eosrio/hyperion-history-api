import {HyperionConfig} from "../../interfaces/hyperionConfig";

export function generateOpenApiConfig(config: HyperionConfig) {
    const packageData = require('../../package');
    const health_link = `https://${config.api.server_name}/v2/health`;
    const explorer_link = `https://${config.api.server_name}/v2/explore`;
    let description = `
<img height="64" src="https://eosrio.io/hyperion.png">
### Scalable Full History API Solution for EOSIO based blockchains
*Made with ♥️ by [EOS Rio](https://eosrio.io/)*
***
#### Current Chain: ${config.api.chain_name} <img style="transform: translateY(8px)" height="32" src="${config.api.chain_logo_url}">
#### Provided by [${config.api.provider_name}](${config.api.provider_url})
#### Health API: <a target="_blank" href="${health_link}">${health_link}</a>
`;
    if(config.api.enable_explorer) {
        description += `#### Integrated Explorer: <a target="_blank" href="${explorer_link}">${explorer_link}</a>`
    }
    return {
        routePrefix: '/v2/docs',
        exposeRoute: true,
        swagger: {
            info: {
                title: `Hyperion History API for ${config.api.chain_name}`,
                description: description,
                version: packageData.version
            },
            host: config.api.server_name,
            schemes: ['https', 'http'],
            consumes: ['application/json'],
            produces: ['application/json']
        }
    };
}
