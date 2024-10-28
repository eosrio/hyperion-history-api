export const hyperionModule = {
    chain: '*',
    contract: 'eosio',
    action: 'buyram',
    defineQueryPrefix: 'buyram',
    parser_version: ['3.2', '2.1', '1.8', '1.7'],
    handler: (action) => {
        const data = action['act']['data'];
        action['@buyram'] = {
            payer: data['payer'],
            receiver: data['receiver'],
        };
        if (data['quant']) {
            action['@buyram']['quant'] = parseFloat(data['quant'].split(' ')[0]);
        }
        delete action['act']['data'];
    },
};
