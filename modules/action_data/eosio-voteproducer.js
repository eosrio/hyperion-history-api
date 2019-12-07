const hyperionModule = {
    chain: "*",
    contract: 'eosio',
    action: 'voteproducer',
    parser_version: ['1.8', '1.7'],
    mappings: {
        action: {
            "@voteproducer": {
                "properties": {
                    "proxy": {"type": "keyword"},
                    "producers": {"type": "keyword"}
                }
            }
        }
    },
    handler: (action) => {
        // attach action extras here
        const data = action['act']['data'];
        action['@voteproducer'] = {
            proxy: data['proxy'],
            producers: data['producers']
        };
    }
};

module.exports = {hyperionModule};
