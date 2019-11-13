const hyperionModule = {
    chain: "*",
    contract: process.env.SYSTEM_DOMAIN,
    action: 'updateauth',
    parser_version: '1.8',
    handler: (action) => {
        // attach action extras here
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
