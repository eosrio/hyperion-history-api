const hyperionModule = {
    chain: "*",
    contract: 'eosio',
    action: 'buyram',
    defineQueryPrefix: 'buyram',
    parser_version: ['1.8','1.7'],
    handler: (action) => {
        const data = action['act']['data'];
        action['@buyram'] = {
            quant: parseFloat(data['quant'].split(' ')[0]),
            payer: data['payer'],
            receiver: data['receiver']
        };
        delete action['act']['data'];
    }
};

module.exports = {hyperionModule};
