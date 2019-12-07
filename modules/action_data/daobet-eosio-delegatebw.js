const hyperionModule = {
    chain: "74d023a9293d9b68c3c52e2f738ee681c1671cc3dc0f263cf2c533cd5523ff95",
    contract: 'eosio',
    action: 'delegatebw',
    parser_version: ['1.7'],
    mappings: {
        action: {
            "@delegatebw": {
                "properties": {
                    "from": {"type": "keyword"},
                    "receiver": {"type": "keyword"},
                    "stake_cpu_quantity": {"type": "float"},
                    "stake_net_quantity": {"type": "float"},
                    "stake_vote_quantity": {"type": "float"},
                    "transfer": {"type": "boolean"},
                    "amount": {"type": "float"}
                }
            }
        }
    },
    handler: (action) => {
        // attach action extras here
        const data = action['act']['data'];
        let cpu_qtd = null;
        let net_qtd = null;
        let vote_qtd = null;
        if (data['stake_net_quantity'] && data['stake_cpu_quantity'] && data['stake_vote_quantity']) {
            cpu_qtd = parseFloat(data['stake_cpu_quantity'].split(' ')[0]);
            net_qtd = parseFloat(data['stake_net_quantity'].split(' ')[0]);
            vote_qtd = parseFloat(data['stake_vote_quantity'].split(' ')[0]);
        }
        action['@delegatebw'] = {
            amount: cpu_qtd + net_qtd + vote_qtd,
            stake_cpu_quantity: cpu_qtd,
            stake_net_quantity: net_qtd,
            stake_vote_quantity: vote_qtd,
            from: data['from'],
            receiver: data['receiver'],
            transfer: data['transfer']
        };
        delete action['act']['data'];
    }
};

module.exports = {hyperionModule};
