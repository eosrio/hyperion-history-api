export const hyperionModule = {
    chain: "*",
    contract: 'eosio',
    action: 'buyrex',
    defineQueryPrefix: 'buyrex',
    parser_version: ['3.2', '2.1', '1.8', '1.7'],
    handler: (action: any) => {
        const data = action['act']['data'];
        let qtd = 0;
        if (data['amount']) {
            qtd = parseFloat(data['amount'].split(' ')[0]);
        }
        action['@buyrex'] = {
            amount: qtd,
            from: data['from']
        };
    }
};
