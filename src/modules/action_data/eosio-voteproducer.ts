import {HyperionActionTransform} from "../../interfaces/hyperion-action-transform.js";

export const hyperionModule: HyperionActionTransform = {
    chain: "*",
    contract: 'eosio',
    action: 'voteproducer',
    parser_version: ['2.1', '1.8', '1.7'],
    defineQueryPrefix: 'voteproducer',
    mappings: {
        action: {
            "@voteproducer": {
                "properties": {
                    "proxy": {"type": "keyword"},
                    "producers": {"type": "keyword"}
                }
            }
        }
    },
    handler: (action) => {
        const data = action['act']['data'];
        action['@voteproducer'] = {
            proxy: data['proxy'],
            producers: data['producers']
        };
    }
};
