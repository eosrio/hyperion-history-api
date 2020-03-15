import {HyperionConfig} from "../interfaces/hyperionConfig";
import {ConnectionManager} from "../connections/manager.class";
import {HyperionModuleLoader} from "../modules/loader";
import {ConfigurationModule} from "../modules/config";
import {JsonRpc} from "eosjs/dist";
import {Client} from "@elastic/elasticsearch";
import {Channel, ConfirmChannel} from "amqplib/callback_api";
import {EventEmitter} from "events";
import * as v8 from "v8";
import {HeapInfo} from "v8";
import {hLog} from "../helpers/common_functions";
import {StateHistorySocket} from "../connections/state-history";

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
    ship: StateHistorySocket;

    txEnc = new TextEncoder();
    txDec = new TextDecoder();
    cch_ready = false;
    ch_ready = false;

    events: EventEmitter;

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
        this.events = new EventEmitter();

        // Connect to RabbitMQ (amqplib)
        this.connectAMQP().then(() => {
            this.onConnect();
        }).catch(console.log);

        // handle ipc messages
        process.on('message', (msg: any) => {
            if (msg.event === 'request_v8_heap_stats') {
                const report: HeapInfo = v8.getHeapStatistics();
                const used_pct = report.used_heap_size / report.heap_size_limit;
                process.send({
                    event: 'v8_heap_report',
                    id: process.env.worker_role + ':' + process.env.worker_id,
                    data: {
                        heap_usage: (used_pct * 100).toFixed(2) + "%"
                    }
                });
                return;
            }
            this.onIpcMessage(msg);
        });
    }

    async connectAMQP() {
        [this.ch, this.cch] = await this.manager.createAMQPChannels((channels) => {
            [this.ch, this.cch] = channels;
            hLog('AMQP Reconnecting...');
            this.onConnect();
        }, () => {
            this.ch_ready = false;
            this.cch_ready = false;
        });
    }

    onConnect() {
        this.ch_ready = true;
        this.cch_ready = true;
        this.assertQueues();
        this.ch.on('close', () => {
            this.ch_ready = false;
        });
        this.cch.on('close', () => {
            this.cch_ready = false;
        });
        this.events.emit('ready');
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

