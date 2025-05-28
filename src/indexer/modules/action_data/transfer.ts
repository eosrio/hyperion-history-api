import { join } from "node:path";
import { existsSync, readFileSync } from "fs";
import { HyperionConfig } from "../../../interfaces/hyperionConfig.js";
import { getConfigPath } from "../../helpers/common_functions.js";

const configJsonPath = getConfigPath();
let configPath = join(import.meta.dirname, '../../../../', configJsonPath || '');
if (!existsSync(configPath)) {
    configPath = configJsonPath;
    if (!existsSync(configPath)) {
        throw new Error(`chain config not found - ${configPath}`);
    }
}
const config = JSON.parse(readFileSync(configPath).toString()) as HyperionConfig;

export const hyperionModule = {
    chain: '*',
    contract: '*',
    action: 'transfer',
    parser_version: ['3.2', '2.1', '1.8', '1.7'],
    defineQueryPrefix: 'transfer',
    handler: (action: any) => {
        let qtd: string[] | null = null;
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
