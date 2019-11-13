const hyperionModule = {
    chain: "*",
    contract: process.env.SYSTEM_DOMAIN,
    action: 'buyrambytes',
    parser_version: '1.8',
    handler: (action) => {
        // attach action extras here
        const data = action['act']['data'];
        action['@buyrambytes'] = {
            bytes: parseInt(data['bytes']),
            payer: data['payer'],
            receiver: data['receiver'],
        };
        delete action['act']['data'];
    }
};

module.exports = {hyperionModule};
