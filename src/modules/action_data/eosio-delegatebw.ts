import {HyperionActionTransform} from "../../interfaces/hyperion-action-transform.js";
import {HyperionAction} from "../../interfaces/hyperion-action.js";

export const hyperionModule: HyperionActionTransform = {
    chain: "*",
    contract: 'eosio',
    action: 'delegatebw',
    parser_version: ['2.1', '1.8', '1.7'],
    defineQueryPrefix: 'delegatebw',
    handler: (action: HyperionAction) => {
        const data = action['act']['data'];
        let cpu_qtd = 0;
        let net_qtd = 0;
        if (data['stake_net_quantity'] && data['stake_cpu_quantity']) {
            cpu_qtd = parseFloat(data['stake_cpu_quantity'].split(' ')[0]);
            net_qtd = parseFloat(data['stake_net_quantity'].split(' ')[0]);
        }
        action['@delegatebw'] = {
            amount: cpu_qtd + net_qtd,
            stake_cpu_quantity: cpu_qtd,
            stake_net_quantity: net_qtd,
            from: data['from'],
            receiver: data['receiver'],
            transfer: data['transfer']
        };
        delete action['act']['data'];
    }
};
