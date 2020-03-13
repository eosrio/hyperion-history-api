import {hLog} from "../helpers/common_functions";

const got = require('got');
import {connect, Connection} from 'amqplib';

const {debugLog} = require("../helpers/functions");

export async function createConnection(config): Promise<Connection> {
    try {
        const amqp_url = getAmpqUrl(config);
        const conn: Connection = await connect(amqp_url);
        debugLog("[AMQP] connection established");
        return conn;
    } catch (e) {
        console.log("[AMQP] failed to connect!");
        console.log(e.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return await createConnection(config);
    }
}

export function getAmpqUrl(config): string {
    return `amqp://${config.user}:${config.pass}@${config.host}/%2F${config.vhost}`;
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

export async function amqpConnect(onReconnect, config) {
    let connection = await createConnection(config);
    if (connection) {
        const channels = await createChannels(connection);
        if (channels) {
            connection.on('error', (err) => {
                hLog(err.message);
            });
            connection.on('close', () => {
                hLog('Connection closed!');
                setTimeout(async () => {
                    hLog('Retrying in 5 seconds...');
                    const _channels = await amqpConnect(onReconnect, config);
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

export async function checkQueueSize(q_name, config) {
    try {
        const apiUrl = `http://${config.user}:${config.pass}@${config.api}/api/queues/%2F${config.vhost}/${q_name}`;
        const result = JSON.parse((await got(apiUrl)).body);
        return result.messages;
    } catch (e) {
        console.log('Checking queue size failed, HTTP API is not ready!');
        return 10000000;
    }
}
