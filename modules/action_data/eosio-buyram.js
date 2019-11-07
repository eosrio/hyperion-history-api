const hyperionModule = {
    chain: "*",
    contract: 'eosio',
    action: 'buyram',
    parser_version: '1.8',
    handler: (action) => {
        // attach action extras here
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
