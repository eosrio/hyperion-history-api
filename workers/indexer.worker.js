const async = require('async');
const pmx = require("pmx");
const {routes} = require("../helpers/elastic-routes");

const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

let ch;
let ch_ready = false;

const indexingPrefecthCount = parseInt(process.env.INDEX_PREFETCH, 10);

const indexQueue = async.cargo(async.ensureAsync(router), indexingPrefecthCount);

function router(payload, callback) {
    if (ch_ready && payload) {
        routes[process.env.type](payload, ch, callback);
    }
}

function assertQueues() {
    try {
        if (ch) {
            ch_ready = true;
            if (indexQueue.paused) {
                indexQueue.resume();
            }
            ch.on('close', () => {
                indexQueue.pause();
                ch_ready = false;
            });
            ch.assertQueue(process.env['queue'], {durable: true});
            ch.prefetch(indexingPrefecthCount);
            ch.consume(process.env['queue'], indexQueue.push);
            console.log(`setting up indexer on queue ${process.env['queue']}`);
        }
    } catch (e) {
        console.error('rabbitmq error!');
        console.log(e);
        process.exit(1);
    }
}


async function run() {

    [ch,] = await manager.createAMQPChannels((channels) => {
        [ch,] = channels;
        assertQueues();
    });

    assertQueues();

    pmx['action']('stop', (reply) => {
        ch.close();
        reply({
            event: 'index_channel_closed'
        });
    });
}

module.exports = {run};
