import {debugLog, hLog} from "../helpers/common_functions";
import got, {HTTPError} from "got";
import amqp, {ChannelWrapper} from "amqp-connection-manager";
import {IAmqpConnectionManager} from "amqp-connection-manager/dist/types/AmqpConnectionManager";

export async function createConnection(config): Promise<IAmqpConnectionManager> {
    try {
        const amqp_url = getAmpqUrl(config);
        // const conn: Connection = await connect(amqp_url);
        const conn: IAmqpConnectionManager = amqp.connect(amqp_url);
        debugLog("[AMQP] connection established");
        return conn;
    } catch (e) {
        hLog("[AMQP] failed to connect!");
        hLog(e.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return await createConnection(config);
    }
}

export function getAmpqUrl(config): string {
    let frameMaxValue = '0x10000';
    if (config.frameMax) {
        frameMaxValue = config.frameMax;
    }
    const u = encodeURIComponent(config.user);
    const p = encodeURIComponent(config.pass);
    const v = encodeURIComponent(config.vhost);
    return `amqp://${u}:${p}@${config.host}/${v}?frameMax=${frameMaxValue}`;
}

async function createChannels(connection: IAmqpConnectionManager) {
    try {
        // const channel = await connection.createChannel();
        const channel = connection.createChannel({
            confirm: false
        });
        // const confirmChannel = await connection.createConfirmChannel();
        const confirmChannel = connection.createChannel({
            confirm: true
        })
        return [channel, confirmChannel];
    } catch (e) {
        hLog("[AMQP] failed to create channels");
        hLog(e);
        return null;
    }
}

export async function amqpConnect(onReconnect, config, onClose): Promise<ChannelWrapper[] | null> {
    let connection = await createConnection(config);
    if (connection) {
        const channels = await createChannels(connection);
        if (channels) {
            connection.on('error', (err) => {
                hLog(err.message);
            });
            connection.on('close', () => {
                hLog('Connection closed!');
                onClose();
                setTimeout(async () => {
                    hLog('Retrying in 5 seconds...');
                    const _channels = await amqpConnect(onReconnect, config, onClose);
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
        const v = encodeURIComponent(config.vhost);
        const apiUrl = `${config.protocol}://${config.api}/api/queues/${v}/${encodeURIComponent(q_name)}`;
        const opts = {
            username: config.user,
            password: config.pass
        };
        const data = await got.get(apiUrl, opts).json() as any;
        return data.messages;
    } catch (e) {
        hLog(`[WARNING] Checking queue size failed! - ${e.message}`);
        if (e.response && e.response.body) {
            if (e instanceof HTTPError) {
                hLog(e.response.body);
            } else {
                hLog(JSON.stringify(e.response.body, null, 2));
            }
        }
        return 0;
    }
}
