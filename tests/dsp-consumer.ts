import {ConfigurationModule} from "../modules/config";
import {ConnectionManager} from "../connections/manager.class";
import {HyperionConfig} from "../interfaces/hyperionConfig";
import {Message} from "amqplib/callback_api";
import {ChannelWrapper} from "amqp-connection-manager";

class DspEventConsumer {

    private conf: HyperionConfig;
    private manager: ConnectionManager;
    private ch: ChannelWrapper;
    private ch_ready: boolean = false;
    private lastBlock = 0;
    private lastGS = 0;
    private actionBuffer: Map<number, any[]> = new Map();

    constructor() {
        const cm = new ConfigurationModule();
        this.conf = cm.config;
        this.manager = new ConnectionManager(cm);
    }

    async run() {
        console.log('Starting DSP Consumer...');
        [this.ch] = await this.manager.createAMQPChannels((channels) => {
            [this.ch] = channels;
            this.onConnect().catch(console.log);
        }, () => {
            this.ch_ready = false;
        });
        this.onConnect().catch(console.log);
    }

    private async onConnect(): Promise<void> {
        if (this.conf.settings.dsp_parser) {
            const q = `${this.manager.chain}:dsp`;
            console.log(q);
            await this.ch.assertQueue(q, {durable: true});
            await this.ch.consume(q, (data) => {
                this.onMessage(data);
            }, {
                prefetch: 100
            });
        }
    }

    processBuffer(block_num: number) {
        setTimeout(() => {
            if (this.actionBuffer.has(block_num)) {
                const sortedActions = this.actionBuffer.get(block_num).sort((a, b) => a.global_sequence - b.global_sequence);
                for (const action of sortedActions) {
                    console.log(action['@timestamp'], action.block_num, action.global_sequence);
                }
                this.actionBuffer.delete(block_num);
            }
        }, 500);
    }

    onMessage(msg: Message) {
        try {
            const content: any = JSON.parse(msg.content.toString());
            console.log(content);
            if (content.block_num > this.lastBlock) {
                this.lastBlock = content.block_num;
                this.actionBuffer.set(content.block_num, [content]);
            } else if (content.block_num === this.lastBlock) {
                if (this.actionBuffer.has(this.lastBlock)) {
                    this.actionBuffer.get(this.lastBlock).push(content);
                }
            } else {
                this.actionBuffer.get(content.block_num).push(content);
            }
            this.processBuffer(this.lastBlock);
            this.ch.ack(msg);
        } catch (e) {
            this.ch.nack(msg);
        }
    }

}

new DspEventConsumer().run().catch(console.error);
