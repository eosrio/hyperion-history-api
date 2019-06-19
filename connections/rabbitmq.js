const amqp = require('amqplib');
const amqp_username = process.env.AMQP_USER;
const amqp_password = process.env.AMQP_PASS;
const amqp_host = process.env.AMQP_HOST;
const amqp_vhost = 'hyperion';
const got = require('got');


async function amqpConnect() {

    const amqp_url = `amqp://${amqp_username}:${amqp_password}@${amqp_host}/%2F${amqp_vhost}`;
    let channel, confirmChannel, connection;
    try {
        connection = await amqp.connect(amqp_url);
        channel = await connection.createChannel();
        confirmChannel = await connection.createConfirmChannel();
    } catch (e) {
        console.log(e);
    }

    connection.on('error', (err) => {
        console.log("[AMQP] error");
        console.log(err);
    });

    return [channel, confirmChannel];
}

async function checkQueueSize(q_name) {
    const apiUrl = `http://${amqp_username}:${amqp_password}@${amqp_host}/api/queues/%2F${amqp_vhost}/${q_name}`;
    const result = JSON.parse((await got(apiUrl)).body);
    return result.messages;
}

module.exports = {
    amqpConnect,
    checkQueueSize
};
