import {HyperionWorker} from "./hyperionWorker";
import {AsyncCargo, cargo} from "async";
import {Serialize} from "../addons/eosjs-native";
import {Type} from "eosjs/dist/eosjs-serialize";
import {deserialize, hLog, serialize} from "../helpers/common_functions";

const {debugLog} = require("../helpers/functions");

export default class StateReader extends HyperionWorker {

    private readonly isLiveReader = process.env['worker_role'] === 'continuous_reader';
    private readonly baseRequest: any;
    private abi: any;
    private qStatusMap = {};
    private recovery = false;
    private tables = new Map();
    private allowRequests = true;
    private pendingRequest = null;
    private completionSignaled = false;
    private stageOneDistQueue: AsyncCargo;
    private blockReadingQueue: AsyncCargo;
    private range_size = parseInt(process.env.last_block) - parseInt(process.env.first_block);
    private completionMonitoring: NodeJS.Timeout;
    private types: Map<string, Type>;
    private local_block_num = parseInt(process.env.first_block, 10) - 1;
    private queueSizeCheckInterval = 5000;
    private local_distributed_count = 0;
    private lastPendingCount = 0;
    private local_last_block = 0;
    private reconnectCount = 0;
    private future_block = 0;
    private drainCount = 0;
    private currentIdx = 1;

    constructor() {
        super();
        if (this.isLiveReader) {
            this.local_block_num = parseInt(process.env.worker_last_processed_block, 10) - 1;
        }
        this.stageOneDistQueue = cargo((tasks, callback) => {
            this.distribute(tasks, callback);
        }, this.conf.prefetch.read);

        this.blockReadingQueue = cargo((tasks, callback) => {
            this.processIncomingBlocks(tasks).then(() => {
                callback();
            }).catch((err) => {
                console.log('FATAL ERROR READING BLOCKS', err);
                process.exit(1);
            })
        }, this.conf.prefetch.read);

        this.baseRequest = {
            max_messages_in_flight: this.conf.prefetch.read,
            have_positions: [],
            irreversible_only: false,
            fetch_block: this.conf.indexer.fetch_block,
            fetch_traces: this.conf.indexer.fetch_traces,
            fetch_deltas: true
        };
    }

    distribute(data, cb) {
        this.recursiveDistribute(data, this.cch, cb);
    }

    recursiveDistribute(data, channel, cb) {
        if (data.length > 0) {
            const q = this.isLiveReader ? this.chain + ':live_blocks' : this.chain + ":blocks:" + this.currentIdx;
            if (!this.qStatusMap[q]) {
                this.qStatusMap[q] = true;
            }
            if (this.qStatusMap[q] === true) {
                if (this.cch_ready) {
                    const d = data.pop();
                    const result = channel.sendToQueue(q, d.content, {
                        persistent: true,
                        mandatory: true,
                    }, (err) => {
                        if (err !== null) {
                            console.log('Message nacked!');
                            console.log(err.message);
                        } else {
                            process.send({event: 'read_block', live: this.isLiveReader});
                        }
                    });

                    if (!this.isLiveReader) {
                        this.local_distributed_count++;
                        debugLog(`Block Number: ${d.num} - Range progress: ${this.local_distributed_count}/${this.range_size}`);
                        if (this.local_distributed_count === this.range_size) {
                            this.signalReaderCompletion();
                        }
                        this.currentIdx++;
                        if (this.currentIdx > this.conf.scaling.ds_queues) {
                            this.currentIdx = 1;
                        }
                    }
                    if (result) {
                        if (data.length > 0) {
                            this.recursiveDistribute(data, channel, cb);
                        } else {
                            cb();
                        }
                    } else {
                        // Send failed
                        this.qStatusMap[q] = false;
                        this.drainCount++;
                        setTimeout(() => {
                            this.recursiveDistribute(data, channel, cb);
                        }, 500);
                    }
                } else {
                    console.log('channel is not ready!');
                }
            } else {
                console.log(`waiting for [${q}] to drain!`);
            }
        } else {
            cb();
        }
    }

    assertQueues(): void {
        if (this.isLiveReader) {
            const live_queue = this.chain + ':live_blocks';
            this.ch.assertQueue(live_queue, {
                durable: true
            });
            this.ch.on('drain', () => {
                console.log('drain...');
                this.qStatusMap[live_queue] = true;
            });
        } else {
            for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
                // console.log(`Asserting queue ${this.chain + ":blocks:" + (i + 1)}`);
                this.ch.assertQueue(this.chain + ":blocks:" + (i + 1), {
                    durable: true
                });

                this.ch.on('drain', () => {
                    console.log('drain...');
                    this.qStatusMap[this.chain + ":blocks:" + (i + 1)] = true;
                });
            }
        }
        if (this.cch) {
            this.cch_ready = true;
            this.stageOneDistQueue.resume();
            this.cch.on('close', () => {
                this.cch_ready = false;
                this.stageOneDistQueue.pause();
            });
        }
    }

    onIpcMessage(msg: any): void {
        switch (msg.event) {
            case 'new_range': {
                if (msg.target === process.env.worker_id) {
                    debugLog(`new_range [${msg.data.first_block},${msg.data.last_block}]`);
                    this.local_distributed_count = 0;
                    clearInterval(this.completionMonitoring);
                    this.completionMonitoring = null;
                    this.completionSignaled = false;
                    this.local_last_block = msg.data.last_block;
                    this.range_size = parseInt(msg.data.last_block) - parseInt(msg.data.first_block);
                    if (this.allowRequests) {
                        this.requestBlockRange(msg.data.first_block, msg.data.last_block);
                        this.pendingRequest = null;
                    } else {
                        this.pendingRequest = [msg.data.first_block, msg.data.last_block];
                    }
                }
                break;
            }
            case 'stop': {
                if (this.isLiveReader) {
                    console.log('[LIVE READER] Closing Websocket');
                    this.ship.close();
                    setTimeout(() => {
                        console.log('[LIVE READER] Process killed');
                        process.exit(1);
                    }, 2000);
                }
            }
        }
    }

    async run(): Promise<void> {
        this.startQueueWatcher();
        this.events.once('ready', () => {
            this.startWS();
        });
    }

    private signalReaderCompletion() {
        if (!this.completionSignaled) {
            this.completionSignaled = true;
            debugLog('reader ' + process.env['worker_id'] + ' signaled completion', this.range_size, this.local_distributed_count);
            this.local_distributed_count = 0;
            this.completionMonitoring = setInterval(() => {
                let pending = 0;
                const unconfirmed = this.cch['unconfirmed'];
                if (unconfirmed.length > 0) {
                    unconfirmed.forEach((elem) => {
                        if (elem) {
                            pending++;
                        }
                    });
                    if (pending === this.lastPendingCount && pending > 0) {
                        // console.log(`[${process.env['worker_id']}] Pending blocks: ${pending}`);
                    } else {
                        this.lastPendingCount = pending;
                    }
                }
                if (pending === 0) {
                    debugLog('reader ' + process.env['worker_id'] + ' completed', this.range_size, this.local_distributed_count);
                    clearInterval(this.completionMonitoring);
                    process.send({
                        event: 'completed',
                        id: process.env['worker_id']
                    });
                }
            }, 200);
        }
    }

    private async processIncomingBlocks(block_array: any[]) {
        if (this.abi) {
            for (const block of block_array) {
                try {
                    await this.onMessage(block);
                } catch (e) {
                    console.log(e);
                }
            }
            this.ackBlockRange(block_array.length);
        } else {
            await this.onMessage(block_array[0]);
        }
        return true;
    }

    private async onMessage(data: any) {
        if (this.abi) {
            // NORMAL OPERATION MODE WITH ABI PRESENT
            if (!this.recovery) {
                // NORMAL OPERATION MODE
                if (process.env.worker_role) {
                    const res = deserialize('result', data, this.txEnc, this.txDec, this.types)[1];
                    if (res['this_block']) {
                        const blk_num = res['this_block']['block_num'];
                        if (this.isLiveReader) {
                            // LIVE READER MODE
                            if (blk_num !== this.local_block_num + 1) {
                                hLog(`exptected: ${this.local_block_num + 1}, received: ${blk_num}`);
                                await this.handleFork(res);
                            } else {
                                this.local_block_num = blk_num;
                            }
                            this.stageOneDistQueue.push({num: blk_num, content: data});
                            return 1;
                        } else {
                            // BACKLOG MODE
                            if (this.future_block !== 0 && this.future_block === blk_num) {
                                console.log('Missing block ' + blk_num + ' received!');
                            } else {
                                this.future_block = 0;
                            }
                            if (blk_num === this.local_block_num + 1) {
                                this.local_block_num = blk_num;
                                if (res['block'] || res['traces'] || res['deltas']) {
                                    this.stageOneDistQueue.push({num: blk_num, content: data});
                                    return 1;
                                } else {
                                    if (blk_num === 1) {
                                        this.stageOneDistQueue.push({num: blk_num, content: data});
                                        return 1;
                                    } else {
                                        return 0;
                                    }
                                }
                            } else {
                                console.log(`[${process.env['worker_role']}] missing block: ${(this.local_block_num + 1)} current block: ${blk_num}`);
                                this.future_block = blk_num + 1;
                                return 0;
                            }
                        }
                    } else {
                        return 0;
                    }
                } else {
                    console.log("[FATAL ERROR] undefined role! Exiting now!");
                    this.ship.close();
                    process.exit(1);
                }

            } else {

                // RECOVERY MODE
                if (this.isLiveReader) {
                    console.log(`Resuming live stream from block ${this.local_block_num}...`);
                    this.requestBlocks(this.local_block_num + 1);
                    this.recovery = false;
                } else {
                    if (!this.completionSignaled) {
                        let first = this.local_block_num;
                        let last = this.local_last_block;
                        if (last === 0) {
                            last = parseInt(process.env.last_block, 10);
                        }
                        last = last - 1;
                        if (first === 0) {
                            first = parseInt(process.env.first_block, 10);
                        }
                        console.log(`Resuming stream from block ${first} to ${last}...`);
                        if (last - first > 0) {
                            this.requestBlockRange(first, last);
                            this.recovery = false;
                        } else {
                            console.log('Invalid range!');
                        }
                    } else {
                        console.log('Reader already finished, no need to restart.');
                        this.recovery = false;
                    }
                }

            }
        } else {
            this.processFirstABI(data);
            return 1;
        }
    }

    private processFirstABI(data: any) {
        this.abi = JSON.parse(data);
        this.types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), this.abi);
        this.abi.tables.map(table => this.tables.set(table.name, table.type));
        process.send({event: 'init_abi', data: data});
        // console.log('state reader sent first abi!');
        if (!this.conf.indexer.disable_reading) {
            switch (process.env['worker_role']) {
                case 'reader': {
                    this.requestBlocks(0);
                    break;
                }
                case 'continuous_reader': {
                    this.requestBlocks(parseInt(process.env['worker_last_processed_block'], 10));
                    break;
                }
            }
        } else {
            this.ship.close();
            process.exit(1);
        }
    }

    private requestBlocks(start: number) {
        const first_block = start > 0 ? start : process.env.first_block;
        const last_block = start > 0 ? 0xffffffff : process.env.last_block;
        const request = this.baseRequest;
        request.start_block_num = parseInt(first_block > 0 ? first_block.toString() : '1', 10);
        request.end_block_num = parseInt(last_block.toString(), 10);
        debugLog(`Reader ${process.env.worker_id} requestBlocks from: ${request.start_block_num} to: ${request.end_block_num}`);
        this.send(['get_blocks_request_v0', request]);
    }

    private send(req_data: (string | any)[]) {
        this.ship.send(serialize('request', req_data, this.txEnc, this.txDec, this.types));
    }

    private requestBlockRange(first: any, last: any) {
        const request = this.baseRequest;
        request.start_block_num = parseInt(first, 10);
        this.local_block_num = request.start_block_num - 1;
        request.end_block_num = parseInt(last, 10);
        debugLog(`Reader ${process.env.worker_id} requestBlockRange from: ${request.start_block_num} to: ${request.end_block_num}`);
        this.send(['get_blocks_request_v0', request]);
    }

    private async handleFork(data: any) {
        const this_block = data['this_block'];
        await this.logForkEvent(this_block['block_num'], this.local_block_num, this_block['block_id']);
        console.log(`Handling fork event: new block ${this_block['block_num']} has id ${this_block['block_id']}`);
        console.log(`Removing indexed data from ${this_block['block_num']} to ${this.local_block_num}`);
        const searchBody = {
            query: {
                bool: {
                    must: [{range: {block_num: {gte: this_block['block_num'], lte: this.local_block_num}}}]
                }
            }
        };
        const indexName = this.chain + '-delta-' + this.conf.settings.index_version + '-*';
        const {body} = await this.client.deleteByQuery({
            index: indexName,
            refresh: true,
            body: searchBody
        });
        console.log(body);
        console.log(`Live reading resumed!`);
    }

    private async logForkEvent(starting_block, ending_block, new_id) {
        await this.client.index({
            index: this.chain + '-logs',
            body: {
                type: 'fork',
                '@timestamp': new Date().toISOString(),
                'fork.from_block': starting_block,
                'fork.to_block': ending_block,
                'fork.size': ending_block - starting_block + 1,
                'fork.new_block_id': new_id
            }
        });
    }

    private ackBlockRange(size: number) {
        this.send(['get_blocks_ack_request_v0', {num_messages: size}]);
    }

    private startQueueWatcher() {
        setInterval(() => {
            let checkArr = [];
            for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
                const q = this.chain + ":blocks:" + (i + 1);
                checkArr.push(this.manager.checkQueueSize(q));
            }
            Promise.all(checkArr).then(data => {
                if (data.some(el => el > this.conf.scaling.queue_limit)) {
                    this.allowRequests = false;
                } else {
                    this.allowRequests = true;
                    if (this.pendingRequest) {
                        this.processPending();
                    }
                }
            });
        }, this.queueSizeCheckInterval);
    }

    private processPending() {
        this.requestBlockRange(this.pendingRequest[0], this.pendingRequest[1]);
        this.pendingRequest = null;
    }

    private startWS() {
        this.ship.connect(
            this.blockReadingQueue.push,
            this.handleLostConnection.bind(this),
            () => {
                hLog('connection failed');
            }, () => {
                this.reconnectCount = 0;
            }
        );
    }

    private handleLostConnection() {
        this.recovery = true;
        this.ship.close();
        hLog(`Retrying connection in 5 seconds... [attempt: ${this.reconnectCount + 1}]`);
        debugLog('PENDING REQUESTS:', this.pendingRequest);
        debugLog('LOCAL BLOCK:', this.local_block_num);
        setTimeout(() => {
            this.reconnectCount++;
            this.startWS();
        }, 5000);
    }
}
