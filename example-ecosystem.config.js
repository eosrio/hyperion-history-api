const {addApiServer, addIndexer} = require("./definitions/ecosystem_settings");

module.exports = {
    apps: [
        // launch indexer
        addIndexer('eos'),

        // launch a single threaded api
        addApiServer('eos', 1)

        // example: launching a 4-node cluster of apis using pm2 cluster
        // addApiServer('eos', 4)
    ]
};
