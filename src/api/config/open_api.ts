import {HyperionConfig} from "../../interfaces/hyperionConfig.js";
import {SwaggerOptions} from "@fastify/swagger";
import {join} from "node:path";
import {readFileSync} from "fs";

export function generateOpenApiConfig(config: HyperionConfig): SwaggerOptions {

    let server = config.api.server_name;

    if (server.startsWith('https://')) {
        server = server.replace('https://', '');
    } else if (server.startsWith('http://')) {
        server = server.replace('http://', '');
    }

    const packageJsonPath = join(import.meta.dirname, '../../../package.json');
    const packageData = JSON.parse(readFileSync(packageJsonPath).toString()) as any;

    const health_link = `https://${server}/v2/health`;
    const explorer_link = `https://${server}/v2/explore`;


    // <img height="64" src="https://${server}/static/hyperion.png">

    let description = `
### Scalable Full History API Solution for Antelope based blockchains
*Made with ♥️ by [EOS Rio](https://eosrio.io/)*
***
#### Current Chain: ${config.api.chain_name} <img style="transform: translateY(8px)" height="32" src="${config.api.chain_logo_url}">
#### Provided by [${config.api.provider_name}](${config.api.provider_url})
#### Health API: <a target="_blank" href="${health_link}">${health_link}</a>
`;

    if (config.plugins) {
        if (config.plugins.explorer) {
            if (config.plugins.explorer.enabled) {
                description += `#### Integrated Explorer: <a target="_blank" href="${explorer_link}">${explorer_link}</a>`
            }
        }
    }

    return {
        mode: "dynamic",
        openapi: {
            info: {
                title: `Hyperion History API for ${config.api.chain_name}`,
                description: description,
                version: packageData.version
            },
            servers: ['https','http'].map(value => {
                return {
                    url: `${value}://${server}`,
                    description: value.toUpperCase()
                }
            }),
            externalDocs: {
                description: "Hyperion Documentation",
                url: "https://hyperion.docs.eosrio.io"
            }
        }
    };
}
