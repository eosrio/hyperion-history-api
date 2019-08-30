const amqp = require('amqplib');
const amqp_username = process.env.AMQP_USER;
const amqp_password = process.env.AMQP_PASS;
const amqp_host = process.env.AMQP_HOST;
const amqp_vhost = 'hyperion';
const got = require('got');
const amqp_url = `amqp://${amqp_username}:${amqp_password}@${amqp_host}/%2F${amqp_vhost}`;
const {debugLog} = require("../helpers/functions");

async function createConnection() {
    try {
        const conn = await amqp.connect(amqp_url);
        debugLog("[AMQP] connection established");
        return conn;
    } catch (e) {
        console.log("[AMQP] failed to connect!");
        console.log(e.message);
        await new Promise(resolve => {
            setTimeout(() => {
                resolve();
            }, 5000);
        });
        return await createConnection();
    }
}

async function createChannels(connection) {
    try {
        const channel = await connection.createChannel();
        const confirmChannel = await connection.createConfirmChannel();
        return [channel, confirmChannel];
    } catch (e) {
        console.log("[AMQP] failed to create channels");
        console.error(e);
        return null;
    }
}

async function amqpConnect(onReconnect) {
    let connection = await createConnection();
    if (connection) {
        const channels = await createChannels(connection);
        if (channels) {
            // Set connection event handlers
            connection.on('error', (err) => {
                console.log('[AMQP] Error!');
                console.log(err);
            });
            connection.on('close', () => {
                console.log('[AMQP] Connection closed!');
                setTimeout(async () => {
                    console.log('Retrying in 5 seconds...');
                    const _channels = await amqpConnect(onReconnect);
                    onReconnect(_channels);
                    return _channels;
                }, 5000);
            });
            return channels;
        } else {
            return null;
        }
    } else {
        return null;
    }
}

async function checkQueueSize(q_name) {
    try {
        const apiUrl = `http://${amqp_username}:${amqp_password}@${process.env.AMQP_API}/api/queues/%2F${amqp_vhost}/${q_name}`;
        const result = JSON.parse((await got(apiUrl)).body);
        return result.messages;
    } catch (e) {
        console.log('Checking queue size failed, HTTP API is not ready!');
        return 10000000;
    }
}

module.exports = {
    amqpConnect,
    checkQueueSize
};
