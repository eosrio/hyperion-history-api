export const hyperionModule = {
    chain: "*",
    contract: 'eosio',
    action: 'unstaketorex',
    parser_version: ['2.1','1.8','1.7'],
    defineQueryPrefix: 'unstaketorex',
    handler: (action) => {
        const data = action['act']['data'];
        let cpu_qtd = null;
        let net_qtd = null;
        if (data['from_net'] && data['from_cpu']) {
            cpu_qtd = parseFloat(data['from_cpu'].split(' ')[0]);
            net_qtd = parseFloat(data['from_net'].split(' ')[0]);
        }
        action['@unstaketorex'] = {
            amount: cpu_qtd + net_qtd,
            owner: data['owner'],
            receiver: data['receiver']
        };
    }
};

// module.exports = {hyperionModule};
