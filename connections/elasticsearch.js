const elasticsearch = require('@elastic/elasticsearch');

function elasticsearchConnect() {
    if(process.env.ES_USER === '') {
        return new elasticsearch.Client({
            node: `http://${process.env.ES_HOST}`
        });
    } else {
        return new elasticsearch.Client({
            node: `http://${process.env.ES_USER}:${process.env.ES_PASS}@${process.env.ES_HOST}`
        });
    }
}

module.exports = {
    elasticsearchConnect
};
