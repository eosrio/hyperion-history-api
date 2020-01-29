const async = require('async');
const pm2io = require('@pm2/io');
const {routes} = require("../helpers/elastic-routes");
const config = require(`../${process.env.CONFIG_JSON}`);
const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

let ch;
let ch_ready = false;


const indexingPrefecthCount = config.prefetch.index;
const indexQueue = async.cargo(async.ensureAsync(router), indexingPrefecthCount);

let temp_indexed_count = 0;

function router(payload, callback) {
    if (ch_ready && payload) {
        routes[process.env.type](payload, ch, (indexed_size) => {
            if (indexed_size) {
                temp_indexed_count += indexed_size;
            }
            callback();
        });
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
            console.log(`indexer listening on ${process.env['queue']}`);
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

    // Check for attached debbuger
    if (/--inspect/.test(process.execArgv.join(' '))) {
        const inspector = require('inspector');
        console.log('DEBUGGER', process.env['queue'], inspector.url());
    }

    setInterval(() => {
        if (temp_indexed_count > 0) {
            process.send({event: 'add_index', size: temp_indexed_count});
        }
        temp_indexed_count = 0;
    }, 1000);

    pm2io.action('stop', (reply) => {
        ch.close();
        reply({
            event: 'index_channel_closed'
        });
    });
}

module.exports = {run};
