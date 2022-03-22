import { ConfigurationModule } from "../modules/config";
import { ConnectionManager } from "../connections/manager.class";
class DspEventConsumer {
    constructor() {
        this.ch_ready = false;
        this.lastBlock = 0;
        this.lastGS = 0;
        this.actionBuffer = new Map();
        const cm = new ConfigurationModule();
        this.conf = cm.config;
        this.manager = new ConnectionManager(cm);
    }
    async run() {
        console.log('Starting DSP Consumer...');
        [this.ch] = await this.manager.createAMQPChannels((channels) => {
            [this.ch] = channels;
            this.onConnect();
        }, () => {
            this.ch_ready = false;
        });
        this.onConnect();
    }
    onConnect() {
        if (this.conf.settings.dsp_parser) {
            const q = `${this.manager.chain}:dsp`;
            console.log(q);
            this.ch.prefetch(100);
            this.ch.assertQueue(q, { durable: true });
            this.ch.consume(q, (data) => {
                this.onMessage(data);
            });
        }
    }
    processBuffer(block_num) {
        setTimeout(() => {
            if (this.actionBuffer.has(block_num)) {
                const sortedActions = this.actionBuffer.get(block_num)?.sort((a, b) => a.global_sequence - b.global_sequence);
                if (sortedActions) {
                    for (const action of sortedActions) {
                        console.log(action['@timestamp'], action.block_num, action.global_sequence);
                    }
                }
                this.actionBuffer.delete(block_num);
            }
        }, 500);
    }
    onMessage(msg) {
        if (!msg)
            return;
        try {
            const content = JSON.parse(msg.content.toString());
            console.log(content);
            if (content.block_num > this.lastBlock) {
                this.lastBlock = content.block_num;
                this.actionBuffer.set(content.block_num, [content]);
            }
            else if (content.block_num === this.lastBlock) {
                if (this.actionBuffer.has(this.lastBlock)) {
                    this.actionBuffer.get(this.lastBlock)?.push(content);
                }
            }
            else {
                this.actionBuffer.get(content.block_num)?.push(content);
            }
            this.processBuffer(this.lastBlock);
            this.ch.ack(msg);
        }
        catch (e) {
            this.ch.nack(msg);
        }
    }
}
new DspEventConsumer().run().catch(console.error);
//# sourceMappingURL=dsp-consumer.js.map