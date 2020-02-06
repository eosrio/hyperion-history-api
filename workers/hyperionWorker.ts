import {HyperionConfig} from "../interfaces/hyperionConfig";
import {ConnectionManager} from "../connections/manager.class";
import {HyperionModuleLoader} from "../modules/loader";
import {ConfigurationModule} from "../modules/config";
import {JsonRpc} from "eosjs/dist";
import {Client} from "@elastic/elasticsearch";
import {Channel, ConfirmChannel} from "amqplib/callback_api";

export abstract class HyperionWorker {

    conf: HyperionConfig;
    manager: ConnectionManager;
    mLoader: HyperionModuleLoader;
    chain: string;
    chainId: string;

    // AMQP Channels
    ch: Channel;
    cch: ConfirmChannel;

    rpc: JsonRpc;
    client: Client;
    ship: any;

    txEnc = new TextEncoder();
    txDec = new TextDecoder();

    protected constructor() {
        this.checkDebugger();
        const cm = new ConfigurationModule();
        this.conf = cm.config;
        this.manager = new ConnectionManager(cm);
        this.mLoader = new HyperionModuleLoader(cm);
        this.chain = this.conf.settings.chain;
        this.chainId = this.manager.conn.chains[this.chain].chain_id;

        this.rpc = this.manager.nodeosJsonRPC;
        this.client = this.manager.elasticsearchClient;
        this.ship = this.manager.shipClient;

        // Connect to RabbitMQ (amqplib)
        this.connectAMQP().catch(console.log);

        // handle ipc messages
        process.on('message', (msg: any) => {
            this.onIpcMessage(msg);
        });
    }

    async connectAMQP() {
        [this.ch, this.cch] = await this.manager.createAMQPChannels((channels) => {
            [this.ch, this.cch] = channels;
            this.assertQueues();
        });
    }

    checkDebugger() {
        if (/--inspect/.test(process.execArgv.join(' '))) {
            const inspector = require('inspector');
            console.log('DEBUGGER ATTACHED',
                process.env.worker_role + "::" + process.env.worker_id,
                inspector.url());
        }
    }

    abstract async run(): Promise<void>

    abstract assertQueues(): void

    abstract onIpcMessage(msg: any): void

}

