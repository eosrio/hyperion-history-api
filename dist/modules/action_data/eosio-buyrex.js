export const hyperionModule = {
    chain: "*",
    contract: 'eosio',
    action: 'buyrex',
    defineQueryPrefix: 'buyrex',
    parser_version: ['2.1', '1.8', '1.7'],
    handler: (action) => {
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
// module.exports = {hyperionModule};
