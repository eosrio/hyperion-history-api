import {debugLog, hLog} from "../helpers/common_functions.js";
import {Channel, ChannelModel, ConfirmChannel, connect, Connection} from 'amqplib';
import {AmqpConfig} from "../../interfaces/hyperionConnections.js";

export async function createConnection(config: AmqpConfig): Promise<ChannelModel> {
    try {
        const amqp_url = getAmpqUrl(config);
        const conn = await connect(amqp_url);
        debugLog("[AMQP] connection established");
        return conn;
    } catch (e: any) {
        hLog("[AMQP] failed to connect!");
        hLog(e.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return await createConnection(config);
    }
}

export function getAmpqUrl(config: AmqpConfig): string {
    let frameMaxValue = '0x10000';
    if (config.frameMax) {
        frameMaxValue = config.frameMax;
    }
    const u = encodeURIComponent(config.user);
    const p = encodeURIComponent(config.pass);
    const v = encodeURIComponent(config.vhost);
    return `amqp://${u}:${p}@${config.host}/${v}?frameMax=${frameMaxValue}`;
}

async function createChannels(connection: ChannelModel): Promise<[Channel, ConfirmChannel] | null> {
    try {
        const channel = await connection.createChannel();
        const confirmChannel = await connection.createConfirmChannel();
        return [channel, confirmChannel];
    } catch (e: any) {
        hLog("[AMQP] failed to create channels");
        hLog(e.message);
        return null;
    }
}

export async function amqpConnect(
    onReconnect: ([Channel, ConfirmChannel]) => void,
    config: AmqpConfig,
    onClose: () => void
): Promise<[Channel, ConfirmChannel] | null> {
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
                    if (_channels) {
                        onReconnect(_channels);
                    } else {
                        hLog("Failed to create channels!");
                    }
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

export async function checkQueueSize(q_name: string, config: AmqpConfig) {
    try {
        const v = encodeURIComponent(config.vhost);
        const apiUrl = `${config.protocol}://${config.api}/api/queues/${v}/${encodeURIComponent(q_name)}`;
        const opts = {
            username: config.user,
            password: config.pass
        };

        // FETCH
        const headers = new Headers();
        const auth = Buffer.from(opts.username + ":" + opts.password).toString('base64')
        headers.set('Authorization', 'Basic ' + auth);
        const data = await (await fetch(apiUrl, {
            headers
        })).json() as any;

        // GOT
        // const data = await got.get(apiUrl, opts).json() as any;

        return data.messages;
    } catch (e: any) {

        hLog(`[WARNING] Checking queue size failed! - ${e.message}`);

        // if (e.response && e.response.body) {
        //     if (e instanceof HTTPError) {
        //         hLog(e.response.body);
        //     } else {
        //         hLog(JSON.stringify(e.response.body, null, 2));
        //     }
        // }

        return 0;
    }
}
