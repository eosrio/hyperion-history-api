import { connect, ChannelModel } from 'amqplib';
import { getAmpqUrl } from '../../indexer/connections/amqp.js';
import { readChainConfig, readConnectionConfig } from './functions.js';

export async function monitorBlockQueues(chain: string) {
    console.log('\nMonitoring block processing queues...');
    const connectionConfig = readConnectionConfig();
    const chainConfig = readChainConfig(chain);

    if (!connectionConfig.amqp) {
        console.log('RabbitMQ config not found, skipping queue monitoring.');
        return;
    }

    // Use the existing helper function to build the URL
    const rabbitURL = getAmpqUrl(connectionConfig.amqp);

    let conn: ChannelModel | undefined;
    try {
        console.log(`Connecting to RabbitMQ at ${connectionConfig.amqp.host}...`);
        conn = await connect(rabbitURL);
        
        const channel = await conn.createChannel();
        
        conn.on('error', (err) => {
            console.error('RabbitMQ connection error:', err.message);
        });
        
        conn.on('close', () => {
            console.log('RabbitMQ connection closed');
        });
        
        channel.on('error', (err) => {
            console.error('RabbitMQ channel error:', err.message);
        });

        const queueCount = chainConfig.scaling?.ds_queues || 1;
        const queueNames = Array.from({ length: queueCount }, (_, i) => `${chain}:blocks:${i + 1}`);

        let totalInitialMessages = 0;

        // wait a bit for queues to be populated
        await new Promise(resolve => setTimeout(resolve, 2000));

        for (const q of queueNames) {
            try {
                const qInfo = await channel.checkQueue(q);
                totalInitialMessages += qInfo.messageCount;
            } catch (e: any) {
                // ignore 404
                if (e.code !== 404) {
                    throw e;
                }
            }
        }

        if (totalInitialMessages === 0) {
            console.log('No blocks in queue, processing is likely complete.');
            await conn.close();
            return;
        }

        let totalCurrentMessages = totalInitialMessages;
        const startTime = Date.now();
        let lastUpdateTime = startTime;
        let lastMessageCount = totalCurrentMessages;

        while (totalCurrentMessages > 0) {
            let currentTotal = 0;
            for (const q of queueNames) {
                try {
                    const qInfo = await channel.checkQueue(q);
                    currentTotal += qInfo.messageCount;
                } catch (e: any) {
                    if (e.code !== 404) {
                        throw e;
                    }
                }
            }
            totalCurrentMessages = currentTotal;

            const processed = totalInitialMessages - totalCurrentMessages;
            const progress = (processed / totalInitialMessages) * 100;
            const progressBar = Array(Math.round(progress / 2)).fill('#').join('');
            const emptyBar = Array(50 - Math.round(progress / 2)).fill(' ').join('');

            // Calculate estimated time to finish
            const currentTime = Date.now();
            const elapsedTime = currentTime - startTime;
            let etaText = '';
            
            if (processed > 0 && elapsedTime > 5000) { // Only show ETA after 5 seconds
                const processingRate = processed / (elapsedTime / 1000); // messages per second
                if (processingRate > 0) {
                    const remainingSeconds = totalCurrentMessages / processingRate;
                    const hours = Math.floor(remainingSeconds / 3600);
                    const minutes = Math.floor((remainingSeconds % 3600) / 60);
                    const seconds = Math.floor(remainingSeconds % 60);
                    
                    if (hours > 0) {
                        etaText = ` ETA: ${hours}h ${minutes}m ${seconds}s`;
                    } else if (minutes > 0) {
                        etaText = ` ETA: ${minutes}m ${seconds}s`;
                    } else {
                        etaText = ` ETA: ${seconds}s`;
                    }
                }
            }

            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(`Processing queued blocks... ${totalCurrentMessages} remaining. [${progressBar}${emptyBar}] ${progress.toFixed(2)}%${etaText}`);

            if (totalCurrentMessages > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        process.stdout.write('\n');
        console.log('All blocks processed!');
        await conn.close();

    } catch (error: any) {
        console.error(`\nError monitoring queues: ${error.message}`);
        
        // Provide more specific error messages for common issues
        if (error.message.includes('ConnectionClose')) {
            console.error('This usually indicates authentication issues or RabbitMQ server problems.');
            console.error('Please check:');
            console.error('1. RabbitMQ server is running');
            console.error('2. Username and password are correct in connections.json');
            console.error('3. Network connectivity to RabbitMQ host');
            console.error('4. Virtual host configuration is correct');
        }
        
        if (conn) {
            try {
                await conn.close();
            } catch (closeError) {
                // Ignore close errors if connection is already closed
            }
        }
    }
}
