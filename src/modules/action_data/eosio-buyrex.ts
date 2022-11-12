import {HyperionAction} from "../../interfaces/hyperion-action.js";
import {HyperionActionTransform} from "../../interfaces/hyperion-action-transform.js";

export const hyperionModule: HyperionActionTransform = {
    chain: "*",
    contract: 'eosio',
    action: 'buyrex',
    defineQueryPrefix: 'buyrex',
    parser_version: ['2.1', '1.8', '1.7'],
    handler: (action: HyperionAction) => {
        const data = action['act']['data'];
        action['@buyrex'] = {
            from: data['from']
        };
        if (data['amount']) {
            action['@buyrex']['amount'] = parseFloat(data['amount'].split(' ')[0]);
        }
    }
};