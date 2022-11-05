import {HyperionActionTransform} from "../../interfaces/hyperion-action-transform.js";

export const hyperionModule: HyperionActionTransform = {
    chain: "*",
    contract: 'eosio',
    action: 'newaccount',
    parser_version: ['2.1','1.8','1.7'],
    defineQueryPrefix: 'newaccount',
    handler: (action) => {
        let name = null;
        const data = action['act']['data'];
        if (data['newact']) {
            name = data['newact'];
        } else if (data['name']) {
            name = data['name'];
            delete data['name'];
        }
        if (name) {
            action['@newaccount'] = {
                active: data['active'],
                owner: data['owner'],
                newact: name
            }
        }
    }
};
