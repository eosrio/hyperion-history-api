import {HyperionActionTransform} from "../../interfaces/hyperion-action-transform.js";

export const hyperionModule: HyperionActionTransform = {
    chain: "*",
    contract: 'eosio',
    action: 'unstaketorex',
    parser_version: ['2.1','1.8','1.7'],
    defineQueryPrefix: 'unstaketorex',
    handler: (action) => {
        const data = action['act']['data'];
        let cpu_qtd = 0;
        let net_qtd = 0;
        if (data['from_net'] && data['from_cpu']) {
            cpu_qtd = parseFloat(data['from_cpu'].split(' ')[0]);
            net_qtd = parseFloat(data['from_net'].split(' ')[0]);
        }
        action['@unstaketorex'] = {
            amount: cpu_qtd + net_qtd,
            owner: data['owner'],
            receiver: data['receiver']
        };
    }
};
