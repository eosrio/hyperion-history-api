const config = require(`../../${process.env.CONFIG_JSON}`);

const hyperionModule = {
    chain: "*",
    contract: '*',
    action: 'transfer',
    parser_version: ['1.8','1.7'],
    handler: (action) => {
        // attach action extras here
        let qtd = null;
        const data = action['act']['data'];
        if (data['quantity']) {
            qtd = data['quantity'].split(' ');
        } else if (data['value']) {
            qtd = data['value'].split(' ');
        }
        if (qtd) {
            action['@transfer'] = {
                from: String(data['from']),
                to: String(data['to']),
                amount: parseFloat(qtd[0]),
                symbol: qtd[1]
            };
            delete data['from'];
            delete data['to'];
            if (config.features['index_transfer_memo']) {
                action['@transfer']['memo'] = data['memo'];
                delete data['memo'];
            }
        }
    }
};

module.exports = {hyperionModule};
