export const hyperionModule = {
    chain: "74d023a9293d9b68c3c52e2f738ee681c1671cc3dc0f263cf2c533cd5523ff95",
    contract: 'eosio',
    action: 'undelegatebw',
    parser_version: ['1.7'],
    defineQueryPrefix: 'undelegatebw',
    mappings: {
        action: {
            "@undelegatebw": {
                "properties": {
                    "from": {"type": "keyword"},
                    "receiver": {"type": "keyword"},
                    "unstake_cpu_quantity": {"type": "float"},
                    "unstake_net_quantity": {"type": "float"},
                    "unstake_vote_quantity": {"type": "float"},
                    "amount": {"type": "float"}
                }
            }
        }
    },
    handler: (action) => {
        const data = action['act']['data'];
        let cpu_qtd = null;
        let net_qtd = null;
        let vote_qtd = null;
        if (data['unstake_net_quantity'] && data['unstake_cpu_quantity'] && data['unstake_vote_quantity']) {
            cpu_qtd = parseFloat(data['unstake_cpu_quantity'].split(' ')[0]);
            net_qtd = parseFloat(data['unstake_net_quantity'].split(' ')[0]);
            vote_qtd = parseFloat(data['unstake_vote_quantity'].split(' ')[0]);
        }
        action['@undelegatebw'] = {
            amount: cpu_qtd + net_qtd + vote_qtd,
            unstake_cpu_quantity: cpu_qtd,
            unstake_net_quantity: net_qtd,
            unstake_vote_quantity: vote_qtd,
            from: data['from'],
            receiver: data['receiver']
        };
        delete action['act']['data'];
    }
};
