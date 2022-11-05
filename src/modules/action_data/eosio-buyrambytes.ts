import {HyperionActionTransform} from "../../interfaces/hyperion-action-transform.js";

export const hyperionModule: HyperionActionTransform = {
    chain: "*",
    contract: 'eosio',
    action: 'buyrambytes',
    defineQueryPrefix: 'buyrambytes',
    parser_version: ['2.1','1.8','1.7'],
    handler: (action) => {
        const data = action['act']['data'];
        action['@buyrambytes'] = {
            bytes: parseInt(data['bytes']),
            payer: data['payer'],
            receiver: data['receiver'],
        };
        delete action['act']['data'];
    }
};
