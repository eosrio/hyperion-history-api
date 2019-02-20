const elasticsearch = require("elasticsearch");

function elasticsearchConnect() {
    return new elasticsearch.Client({
        host: process.env.ES_HOST
    });
}

module.exports = {
    elasticsearchConnect
};
