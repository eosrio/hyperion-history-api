const stateReader = require('./state-reader.worker');
const indexer = require('./indexer.worker');
const deserializer = require('./deserializer.worker');
const wsRouter = require('./ws-router.worker');

module.exports = {
    stateReader,
    indexer,
    deserializer,
    wsRouter
};
