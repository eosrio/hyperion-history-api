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
        let qtd = null;
        if (data['amount']) {
            qtd = parseFloat(data['amount'].split(' ')[0]);
        }
        action['@buyrex'] = {
            amount: qtd,
            from: data['from']
        };
    }
};
