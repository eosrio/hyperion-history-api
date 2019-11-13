const hyperionModule = {
    chain: "*",
    contract: process.env.SYSTEM_DOMAIN,
    action: 'buyrex',
    parser_version: '1.8',
    handler: (action) => {
        // attach action extras here
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

module.exports = {hyperionModule};
