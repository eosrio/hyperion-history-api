const hyperionModule = {
    chain: "*",
    contract: 'eosio',
    action: 'newaccount',
    parser_version: '1.8',
    handler: (action) => {
        // attach action extras here
        let name = null;
        if (action['act']['data']['newact']) {
            name = action['act']['data']['newact'];
        } else if (action['act']['data']['name']) {
            name = action['act']['data']['name'];
            delete action['act']['data']['name'];
        }
        if (name) {
            action['@newaccount'] = {
                active: action['act']['data']['active'],
                owner: action['act']['data']['owner'],
                newact: name
            }
        }
    }
};

module.exports = {hyperionModule};
