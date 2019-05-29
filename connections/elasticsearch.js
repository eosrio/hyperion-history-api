const elasticsearch = require("elasticsearch");

function elasticsearchConnect() {
    return new elasticsearch.Client({
        host: `http://${process.env.ES_USER}:${process.env.ES_PASS}@${process.env.ES_HOST}`
    });
}

module.exports = {
    elasticsearchConnect
};
