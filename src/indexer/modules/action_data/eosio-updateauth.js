const hyperionModule = {
    chain: "*",
    contract: 'eosio',
    action: 'updateauth',
    parser_version: ['3.2', '2.1','1.8','1.7'],
    defineQueryPrefix: 'updateauth',
    handler: (action) => {
        const data = action['act']['data'];
        const _auth = data['auth'];
        if (_auth['accounts'].length === 0) delete _auth['accounts'];
        if (_auth['keys'].length === 0) delete _auth['keys'];
        if (_auth['waits'].length === 0) delete _auth['waits'];
        action['@updateauth'] = {
            permission: data['permission'],
            parent: data['parent'],
            auth: _auth
        };
    }
};

module.exports = {hyperionModule};
