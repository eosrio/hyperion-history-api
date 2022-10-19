import {readFileSync} from "node:fs";
import {resolve, join} from "node:path";

const config = JSON.parse(readFileSync(join(resolve(),process.env.CONFIG_JSON)).toString());

export const hyperionModule = {
    chain: '*',
    contract: '*',
    action: 'transfer',
    parser_version: ['2.1', '1.8', '1.7'],
    defineQueryPrefix: 'transfer',
    handler: (action) => {
        let qtd = null;
        const data = action['act']['data'];
        if (data['quantity'] && typeof data['quantity'] === 'string') {
            qtd = data['quantity'].split(' ');
        } else if (data['value'] && typeof data['value'] === 'string') {
            qtd = data['value'].split(' ');
        }
        if (qtd) {
            action['@transfer'] = {
                from: String(data['from']),
                to: String(data['to']),
                amount: parseFloat(qtd[0]),
                symbol: qtd[1],
            };
            delete data['from'];
            delete data['to'];
            if (config.features['index_transfer_memo']) {
                action['@transfer']['memo'] = data['memo'];
                delete data['memo'];
            }
        }
    },
};

// module.exports = {hyperionModule};
