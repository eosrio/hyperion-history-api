import WebSocket from 'ws';
import {cargo, QueueObject} from 'async';
import {Channel, ConfirmChannel} from 'amqplib';
import {ABI, API, Bytes, Checksum256, Serializer, UInt32} from '@wharfkit/antelope';

import {HyperionWorker} from './hyperionWorker.js';
import {debugLog, hLog} from '../helpers/common_functions.js';
import {RabbitQueueDef} from '../definitions/index-queues.js';

interface RequestRange {
    first_block: number;
    last_block: number;
}

interface BlockInfo {
    block_num: UInt32;
    block_id: Checksum256;
}

export interface GetBlocksResultV0 {
    head: BlockInfo;
    last_irreversible: BlockInfo;
    this_block: BlockInfo;
    prev_block: BlockInfo;
    block: Bytes;
    traces: Bytes;
    deltas: Bytes;
}

export default class StateReader extends HyperionWorker {
    private readonly isLiveReader = process.env['worker_role'] === 'continuous_reader';
    private readonly baseRequest: any;

    private shipABI?: ABI;

    private qStatusMap: Record<string, any> = {};
    private recovery = false;
    private allowRequests = true;
    private pendingRequest: [number, number] | null = null;
    private completionSignaled = false;
    private stageOneDistQueue: QueueObject<any>;
    private blockReadingQueue: QueueObject<WebSocket.MessageEvent>;
    private range_size = parseInt(process.env.last_block ?? '0') - parseInt(process.env.first_block ?? '0');
    private completionMonitoring: NodeJS.Timeout | null | undefined;

    private local_block_num = parseInt(process.env.first_block ?? '0', 10) - 1;
    private local_block_id = '';

    // private queueSizeCheckInterval = 5000;

    private local_distributed_count = 0;
    private lastPendingCount = 0;
    private local_last_block = 0;
    private reconnectCount = 0;
    private future_block = 0;
    private drainCount = 0;
    private currentIdx = 1;
    private receivedFirstBlock = false;
    private local_lib = 0;
    private delay_active = false;
    private block_processing_delay = 100;
    private shipRev = 'v0';

    // private tempBlockSizeSum = 0;
    private shipInitStatus: any;

    private idle = true;
    private repairMode = false;
    private internalPendingRanges: RequestRange[] = [];

    // Map to store forked block ids and their timestamps
    private forkedBlocks = new Map<
        string,
        {
            block_num: number;
            timestamp: number;
        }
    >();

    // Map to store reversible block ids indexed by block number
    private reversibleBlockMap: Map<number, string> = new Map();

    constructor() {
        super();
        if (this.isLiveReader && process.env.worker_last_processed_block) {
            this.local_block_num = parseInt(process.env.worker_last_processed_block, 10) - 1;
        }

        this.stageOneDistQueue = cargo((tasks, callback) => {
            this.distribute(tasks, callback);
        }, this.conf.prefetch.read);

        this.blockReadingQueue = cargo((tasks, next) => {
            this.processIncomingBlocks(tasks)
                .then(() => {
                    next();
                })
                .catch((err) => {
                    console.log('FATAL ERROR READING BLOCKS', err);
                    process.exit(1);
                });
        }, this.conf.prefetch.read);

        if (this.conf.indexer.abi_scan_mode) {
            this.conf.indexer.fetch_deltas = true;
        }

        if (typeof this.conf.indexer.fetch_deltas === 'undefined') {
            this.conf.indexer.fetch_deltas = true;
        }

        if (this.conf.settings.ship_request_rev) {
            this.shipRev = this.conf.settings.ship_request_rev;
        }

        this.baseRequest = {
            max_messages_in_flight: this.conf.prefetch.read,
            have_positions: [],
            irreversible_only: false,
            fetch_block: this.conf.indexer.fetch_block,
            fetch_traces: this.conf.indexer.fetch_traces,
            fetch_deltas: this.conf.indexer.fetch_deltas
        };

        if (this.shipRev === 'v1') {
            this.baseRequest.fetch_block_header = true;
        }
    }

    distribute(data: any[], cb: () => void) {
        if (this.cch) {
            this.recursiveDistribute(data, this.cch, cb);
        }
    }

    recursiveDistribute(data: any[], channel: Channel | ConfirmChannel, cb: () => void) {
        if (data.length > 0) {
            const q = this.isLiveReader ? this.chain + ':live_blocks' : this.chain + ':blocks:' + this.currentIdx;
            if (!this.qStatusMap[q]) {
                this.qStatusMap[q] = true;
            }
            if (this.qStatusMap[q] === true) {
                if (this.cch_ready) {
                    const d = data.pop();
                    const result = channel.sendToQueue(
                        q,
                        d.content,
                        {
                            persistent: true,
                            mandatory: true
                        },
                        (err: any) => {
                            if (err !== null) {
                                console.log('Message nacked!');
                                console.log(err.message);
                            } else {
                                if (process.send) {
                                    process.send({
                                        event: 'read_block',
                                        live: this.isLiveReader,
                                        block_num: d.num
                                    });
                                }
                            }
                        }
                    );

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

    async assertQueues(): Promise<void> {
        if (this.ch) {
            if (this.isLiveReader) {
                const live_queue = this.chain + ':live_blocks';
                await this.ch.assertQueue(live_queue, RabbitQueueDef);
                this.ch.on('drain', () => {
                    this.qStatusMap[live_queue] = true;
                });
            } else {
                for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
                    await this.ch.assertQueue(this.chain + ':blocks:' + (i + 1), RabbitQueueDef);
                    this.ch.on('drain', () => {
                        this.qStatusMap[this.chain + ':blocks:' + (i + 1)] = true;
                    });
                }
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

    newRange(data: any) {

        debugLog(`new_range [${data.first_block},${data.last_block}]`);

        this.local_distributed_count = 0;
        if (this.completionMonitoring) {
            clearInterval(this.completionMonitoring);
        }

        this.completionMonitoring = null;
        this.completionSignaled = false;
        this.local_last_block = data.last_block;

        // make sure no data is requested from before the first indexed block on ship
        if (parseInt(data.first_block) < this.shipInitStatus['trace_begin_block']) {
            data.first_block = this.shipInitStatus['trace_begin_block'];
            hLog('Impossible to repair requested range, first block is before the first indexed block on ship, trimming to ' + data.first_block);
        }

        this.range_size = parseInt(data.last_block) - parseInt(data.first_block);

        // if range size is not positive, we need to immediately signal completion to master
        if (this.range_size <= 0) {
            this.emitCompletedSignal();
        }

        // make sure the range doesn't exceed the batch size
        if (this.range_size > this.conf.scaling.batch_size) {
            // split the range into multiple ranges
            const ranges: any[] = [];
            let start = parseInt(data.first_block);
            let end = parseInt(data.last_block);
            
            while (start < end) {
                const s = start;
                const e = start + this.conf.scaling.batch_size;
                ranges.push({
                    first_block: s,
                    last_block: e > end ? end : e
                });
                start = e + 1;
            }

            console.log(`Splitting range [${data.first_block},${data.last_block}] into ${ranges.length} ranges`);

            this.internalPendingRanges = ranges;
            const next = this.internalPendingRanges.shift();
            this.newRange(next);
        } else {
            if (this.allowRequests) {
                this.requestBlockRange(data.first_block, data.last_block);
                this.pendingRequest = null;
            } else {
                this.pendingRequest = [data.first_block, data.last_block];
            }
        }
    }

    onIpcMessage(msg: any): void {
        switch (msg.event) {
            case 'new_range': {
                if (msg.target === process.env.worker_id) {
                    this.newRange(msg.data);
                }
                break;
            }
            case 'pause': {
                this.allowRequests = false;
                break;
            }
            case 'resume': {
                this.allowRequests = true;
                if (this.pendingRequest) {
                    this.processPending();
                }
                break;
            }
            case 'set_delay': {
                hLog('received new delay action from master');
                this.delay_active = msg.data.state;
                this.block_processing_delay = msg.data.delay;
                break;
            }
            case 'next_server': {
                hLog('received next server action from master');
                this.ship.close(false);
                break;
            }
            case 'stop': {
                if (this.isLiveReader) {
                    hLog('[LIVE READER] Closing Websocket');
                    this.ship.close(true);
                    setTimeout(() => {
                        hLog('[LIVE READER] Process killed');
                        process.exit(1);
                    }, 2000);
                }
            }
        }
    }

    async run(): Promise<void> {
        // this.startQueueWatcher();
        this.events.once('ready', () => {
            this.startWS();
        });
    }

    private signalReaderCompletion() {
        if (!this.completionSignaled) {
            this.completionSignaled = true;
            debugLog(`Reader completion signal - ${this.range_size} - ${this.local_distributed_count}`);
            this.local_distributed_count = 0;
            this.completionMonitoring = setInterval(() => {
                let pending = 0;

                // @ts-ignore
                const unconfirmed = this.cch['unconfirmed'];

                if (unconfirmed.length > 0) {
                    unconfirmed.forEach((elem: any) => {
                        if (elem) {
                            pending++;
                        }
                    });
                    if (!(pending === this.lastPendingCount && pending > 0)) {
                        this.lastPendingCount = pending;
                    }
                }
                if (pending === 0) {
                    debugLog(`Reader completed - ${this.range_size} - ${this.local_distributed_count}`);

                    if (this.completionMonitoring) {
                        clearInterval(this.completionMonitoring);
                    }

                    // check if there are any pending ranges, then signal completion to master
                    if (this.internalPendingRanges.length === 0) {
                        process.send?.({
                            event: 'completed',
                            id: process.env['worker_id']
                        });
                    } else {
                        // process next range in queue
                        const next = this.internalPendingRanges.shift();
                        this.newRange(next);
                    }
                }
            }, 200);
        }
    }

    private async processIncomingBlocks(block_array: any[]) {
        if (this.shipABI) {
            for (const block of block_array) {
                try {
                    await this.onMessage(block);
                } catch (e) {
                    hLog(e);
                }
            }
            this.ackBlockRange(block_array.length);
        } else {
            await this.onMessage(block_array[0]);
            this.ackBlockRange(block_array.length);
        }
        if (this.delay_active) {
            await new Promise((resolve) => setTimeout(resolve, this.block_processing_delay));
        }
        return true;
    }

    private handleStatusResult(data: any) {
        this.shipInitStatus = Serializer.objectify(data);
        let beingBlock = this.shipInitStatus['chain_state_begin_block'];

        if (this.shipInitStatus['trace_begin_block'] > this.shipInitStatus['chain_state_begin_block']) {
            beingBlock = this.shipInitStatus['trace_begin_block'];
        }

        const endBlock = this.shipInitStatus['chain_state_end_block'];
        hLog(`SHIP Range from ${beingBlock} to ${endBlock}`);

        if (!this.conf.indexer.disable_reading || process.env['worker_role'] === 'repair_reader') {
            switch (process.env['worker_role']) {
                // range reader setup
                case 'reader': {
                    if (process.env.first_block && beingBlock > process.env.first_block) {
                        // skip the snapshot block until a solution to parse it is found
                        const nextBlock = beingBlock;
                        let lastBlock = nextBlock + this.conf.scaling.batch_size;
                        if (process.env.last_block) {
                            const lastRequestedBlock = parseInt(process.env.last_block, 10);
                            if (lastBlock > lastRequestedBlock) {
                                lastBlock = lastRequestedBlock;
                            }
                        }

                        if (beingBlock > lastBlock) {
                            lastBlock = nextBlock + this.conf.scaling.batch_size;
                        }

                        hLog(`First saved block is ahead of requested range! - Req: ${process.env.first_block} | First: ${beingBlock}`);
                        this.local_block_num = nextBlock - 1;
                        process.send?.({
                            event: 'update_last_assigned_block',
                            block_num: lastBlock
                        });
                        this.newRange({first_block: nextBlock, last_block: lastBlock});
                    } else {
                        this.requestBlocks(0);
                    }
                    break;
                }
                // live reader setup
                case 'continuous_reader': {
                    if (process.env.worker_last_processed_block) {
                        this.requestBlocks(parseInt(process.env.worker_last_processed_block, 10));
                    }
                    break;
                }
                // repair reader setup
                case 'repair_reader': {
                    this.repairMode = true;
                    hLog('Waiting for operations...');
                    process.send?.({
                        event: 'repair_reader_ready'
                    });
                    break;
                }
            }
        } else {
            this.ship.close(true);
            process.exit(1);
        }
    }

    private registerReversibleBlock(new_block_num: number, new_block_id: string, res: any) {
        // console.log(`Registering reversible block ${block_num} with id ${block_id}`);
        // console.log(`[${new_block_num}] Reversible map size: ${this.reversibleBlockMap.size} | Forked map size: ${this.forkedBlocks.size}`);

        // check for a forked block being re-applied
        if (this.forkedBlocks.has(new_block_id)) {
            // if the block is already registered, we can check if the id is the same
            const forkedBlock = this.forkedBlocks.get(new_block_id);
            if (forkedBlock && forkedBlock.block_num === new_block_num) {
                // remove the forked block from the map
                this.forkedBlocks.delete(new_block_id);
                hLog(`⚠️ Re-applied forked block ${new_block_num} [${new_block_id}]`);
                console.log(res.this_block);
            }
        }

        // check if the block is already registered
        const existingBlockId = this.reversibleBlockMap.get(new_block_num);
        if (existingBlockId) {
            // if the block is already registered, we can check if the id is the same
            if (existingBlockId !== new_block_id) {
                // if the id is different, we can log a warning or handle it as needed
                debugLog(`Block ${new_block_num} has a different id! Existing: ${existingBlockId}, New: ${new_block_id}`);

                // add the forked block to the pending list for deletion
                this.forkedBlocks.set(existingBlockId, {
                    block_num: new_block_num,
                    timestamp: Date.now()
                });

                // Update the reversible block map with the new id
                this.reversibleBlockMap.set(new_block_num, new_block_id);

                // trigger fork handling
                this.processForkedBlocks();
            } else {
                // if the id is the same, we can log that it's already registered
                hLog(`⚠️⚠️ Block ${new_block_num} is already registered with the same id!`);
                // indexing can be skipped for this one
            }
        } else {
            // register the block for the first time
            this.reversibleBlockMap.set(new_block_num, new_block_id);
        }
    }

    private forkHandlingTimeout: NodeJS.Timeout | null = null;
    private forkHandlingMode = false;

    private processForkedBlocks() {
        if (this.forkHandlingMode) {
            // hLog(`Recent fork event, resetting timeout, delaying fork handling...`);
            if (this.forkHandlingTimeout) {
                clearTimeout(this.forkHandlingTimeout);
                this.forkHandlingTimeout = null;
            }
        } else {
            this.forkHandlingMode = true;
        }
        this.forkHandlingTimeout = setTimeout(() => {
            this.removeForkedBlocks().catch(console.error);
        }, 13 * 500); // wait for a full round to remove forked blocks
    }

    private async removeForkedBlocks() {
        const forkedBlocks = Array.from(this.forkedBlocks.entries());
        hLog(`⚠️ Checking ${forkedBlocks.length} forked blocks for removal...`);
        const pendingList: any[] = [];
        const removedList: any[] = [];
        for (const [block_id, val] of forkedBlocks) {
            try {
                // Confirm the block was actually forked using the chain api
                let blockData: API.v1.GetBlockResponse | null = null;
                try {
                    blockData = await this.rpc.v1.chain.get_block(block_id.toLowerCase());
                    if (blockData) {
                        if (blockData.block_num.toNumber() === val.block_num) {
                            // console.log(`Block ${blockData.block_num.toNumber()} ${block_id} is still present on the chain, not forked.`);
                            // check if the block is older than the last irreversible block
                            if (val.block_num <= this.local_lib) {
                                console.log(`Block ${block_id} is older than the lib, definitely not forked.`);
                                this.forkedBlocks.delete(block_id);
                            } else {
                                // check the current id for the same block number on the reversible block map
                                const currentBlockId = this.reversibleBlockMap.get(blockData.block_num.toNumber());
                                if (currentBlockId && currentBlockId !== block_id) {
                                    // handle as a forked block, since a new different id was received after the fork
                                    blockData = null;
                                } else {
                                    pendingList.push({block_id, ...val});
                                }
                            }
                        } else {
                            hLog(`[WARNING] Unexpected block number for ${block_id}: ${blockData.block_num.toNumber()} (expected: ${val.block_num})`);
                        }
                    }
                } catch (e: any) {
                    console.log(e.message);
                    // delete the block from the forked blocks map
                    this.forkedBlocks.delete(block_id);
                }

                if (blockData === null) {
                    // console.log(`Block ${block_id} not found, confirming it was forked.`);
                    removedList.push({block_id, ...val});
                    await this.deleteForkedBlockById(block_id, val.block_num);
                    // delete the block from the forked blocks map
                    this.forkedBlocks.delete(block_id);
                }
            } catch (e: any) {
                hLog(`Error deleting forked block ${block_id}: ${e.message}`);
            }
        }

        if (pendingList.length > 0) {
            // re-schedule the fork handling
            const lastBlock = pendingList[pendingList.length - 1];
            const timeToLib = (lastBlock.block_num - this.local_lib) * 500;
            console.log(`Block ${lastBlock.block_id} is not forked, rescheduling fork handling in ${timeToLib}ms...`);
            setTimeout(() => {
                this.removeForkedBlocks().catch(console.error);
            }, timeToLib);
        }

        if (removedList.length > 0) {
            this.logForkedBlocks(removedList);
        }

        this.forkHandlingMode = false;
        this.forkHandlingTimeout = null;
    }

    private cleanReversibleBlocks(lib: BlockInfo) {
        // console.log(`Cleaning reversible blocks up to ${lib.block_num}`, lib);
        // remove reversible blocks that are older than the lib
        this.reversibleBlockMap.forEach((block_id, block_num) => {
            if (block_num <= lib.block_num.toNumber()) {
                this.reversibleBlockMap.delete(block_num);
                // console.log(`Deleting reversible block ${block_num} with id ${block_id}`);
            }
        });
    }

    private async handleBlockResult(res: GetBlocksResultV0, data: Buffer) {
        if (res.this_block) {
            this.idle = false;
            const blk_num = res.this_block.block_num.toNumber();
            const blk_id = res.this_block.block_id.toString();
            const lib = res.last_irreversible;
            const task_payload = {
                num: blk_num,
                content: data
            };

            if (res.block && res.traces && res.deltas) {

                if (this.repairMode) {
                    debugLog('Repaired block: ' + blk_num);
                }

                debugLog(
                    `block_num: ${blk_num}, block_size: ${res.block.length}, traces_size: ${res.traces.length}, deltas_size: ${res.deltas.length}`
                );
            } else {
                if (!this.conf.indexer.abi_scan_mode) {
                    if (!res.traces) {
                        debugLog('missing traces field');
                    }
                    if (!res.deltas) {
                        debugLog('missing deltas field');
                    }
                    if (!res.block) {
                        debugLog('missing block field');
                    }
                }
            }

            if (this.isLiveReader) {
                // LIVE READER MODE
                let prev_id: string | undefined = undefined;
                if (res['prev_block'] && res['prev_block']['block_id']) {
                    prev_id = res.prev_block.block_id.toString();
                }

                // Register the reversible block to handle forks later
                this.registerReversibleBlock(blk_num, blk_id, res);

                // if ((this.local_block_id && prev_id && this.local_block_id !== prev_id) || (blk_num !== this.local_block_num + 1)) {
                //
                //     console.log((this.local_block_id && prev_id && this.local_block_id !== prev_id), (blk_num !== this.local_block_num + 1));
                //     console.log(blk_num, this.local_block_num + 1);
                //
                //     hLog(`Unlinked block at ${prev_id} with previous block ${this.local_block_id}`);
                //     hLog(`Forked block: ${blk_num}`);
                //     try {
                //         // delete all previously stored data for the forked blocks
                //         // await this.handleFork(res);
                //     } catch (e: any) {
                //         hLog(`Failed to handle fork during live reading! - Error: ${e.message}`);
                //     }
                // }

                this.local_block_num = blk_num;
                this.local_block_id = blk_id;

                if (lib.block_num.toNumber() > this.local_lib) {
                    this.local_lib = lib.block_num.toNumber();
                    // emit lib update event
                    process.send?.({event: 'lib_update', data: lib});
                    this.cleanReversibleBlocks(lib);
                }

                await this.stageOneDistQueue.push(task_payload);

                return 1;
            } else {
                // Detect skipped first block
                if (!this.receivedFirstBlock) {
                    if (blk_num !== this.local_block_num + 1) {
                        // Special case for block 2 that is actually the first block on ship
                        if (blk_num !== 2) {
                            hLog(`WARNING: First block received was #${blk_num}, but #${this.local_block_num + 1} was expected!`);
                            hLog(`Make sure the block.log file contains the requested range, check with "eosio-blocklog --smoke-test"`);
                        }
                        this.local_block_num = blk_num - 1;
                        this.local_distributed_count++;
                        process.send?.({
                            event: 'skipped_block',
                            block_num: this.local_block_num + 1
                        });
                    }
                    this.receivedFirstBlock = true;
                }

                // BACKLOG MODE
                if (this.future_block !== 0 && this.future_block === blk_num) {
                    hLog('Missing block ' + blk_num + ' received!');
                } else {
                    this.future_block = 0;
                }

                if (blk_num === this.local_block_num + 1) {
                    this.local_block_num = blk_num;
                    if (res['block'] || res['traces'] || res['deltas']) {
                        await this.stageOneDistQueue.push(task_payload);
                        return 1;
                    } else {
                        if (blk_num === 1) {
                            await this.stageOneDistQueue.push(task_payload);
                            return 1;
                        } else {
                            return 0;
                        }
                    }
                } else {
                    hLog(`Missing block: ${this.local_block_num + 1} current block: ${blk_num}`);
                    this.future_block = blk_num + 1;
                    return 0;
                }
            }
        } else {
            if (this.repairMode) {
                hLog('No data on requested block!');
            }
            this.idle = true;
        }
    }

    private async onMessage(data: Buffer) {
        if (!this.shipABI) {
            this.processFirstABI(data);
            return 1;
        }

        if (!process.env.worker_role) {
            hLog('[FATAL ERROR] undefined role! Exiting now!');
            this.ship.close(false);
            process.exit(1);
        }

        // NORMAL OPERATION MODE
        if (!this.recovery) {
            const result = Serializer.decode({
                data,
                type: 'result',
                abi: this.shipABI
            });
            switch (result[0]) {
                case 'get_status_result_v0': {
                    this.handleStatusResult(result[1]);
                    break;
                }
                case 'get_blocks_result_v0': {
                    return await this.handleBlockResult(result[1], data);
                }
                default: {
                    hLog(`Unknown message type: ${result[0]}`);
                }
            }
        } else {
            // RECOVERY MODE
            if (this.isLiveReader) {
                hLog(`Resuming live stream from block ${this.local_block_num}...`);
                this.requestBlocks(this.local_block_num + 1);
                this.recovery = false;
            } else {
                if (!this.completionSignaled) {
                    let first = this.local_block_num;
                    let last = this.local_last_block;
                    if (last === 0) {
                        if (process.env.last_block) {
                            last = parseInt(process.env.last_block, 10);
                        }
                    }
                    last = last - 1;
                    if (first === 0) {
                        if (process.env.first_block) {
                            first = parseInt(process.env.first_block, 10);
                        }
                    }
                    if (first > last) {
                        last = first + 1;
                    }
                    hLog(`Resuming stream from block ${first} to ${last}...`);
                    if (last - first > 0) {
                        this.requestBlockRange(first, last);
                        this.recovery = false;
                    } else {
                        hLog('Invalid range!');
                    }
                } else {
                    hLog('Reader already finished, no need to restart.');
                    this.recovery = false;
                }
            }
        }
    }

    private processFirstABI(data: Buffer) {
        const abiString = data.toString();
        this.abieos.loadAbi('0', abiString);
        this.shipABI = ABI.from(abiString);
        process.send?.({event: 'init_abi', data: abiString});
        // request status
        this.send(['get_status_request_v0', {}]);
    }

    private requestBlocks(start: number) {
        let first_block: string | number = start > 0 ? start : process.env.first_block ? process.env.first_block : 1;
        const last_block = start > 0 ? 0xffffffff : process.env.last_block ? process.env.last_block : 0xffffffff;
        const request = this.baseRequest;
        if (typeof first_block === 'string') {
            request.start_block_num = parseInt(first_block, 10);
        } else {
            if (first_block > 0) {
                request.start_block_num = first_block;
            } else {
                request.start_block_num = 1;
            }
        }
        request.end_block_num = parseInt(last_block.toString(), 10);
        const reqType = 'get_blocks_request_' + this.shipRev;
        if (this.ship.connected) {
            debugLog(`Reader ${process.env.worker_id} sending ${reqType} from: ${request.start_block_num} to: ${request.end_block_num}`);
            this.send([reqType, request]);
        } else {
            hLog('[Warning] Request failed - SHIP is not online!');
        }
    }

    private send(req_data: (string | any)[]) {
        this.ship.send(
            Serializer.encode({
                object: req_data,
                type: 'request',
                abi: this.shipABI
            }).array
        );
    }

    private requestBlockRange(first: any, last: any) {
        const request = this.baseRequest;
        request.start_block_num = parseInt(first, 10);
        this.local_block_num = request.start_block_num - 1;
        request.end_block_num = parseInt(last, 10);
        const reqType = 'get_blocks_request_' + this.shipRev;
        if (this.ship.connected) {
            debugLog(`Reader ${process.env.worker_id} sending ${reqType} from: ${request.start_block_num} to: ${request.end_block_num}`);
            this.send([reqType, request]);
        } else {
            hLog('[Warning] Request failed - SHIP is not online!');
        }
    }

    private async deleteForkedBlockById(block_id: string, block_num: number) {
        const searchBody = {query: {bool: {must: [{term: {block_id: block_id}}]}}};

        // use the block_num and the index partition size to determine the index to search
        const indexPartition = Math.floor(block_num / this.conf.settings.index_partition_size);
        const indexName = this.chain + '-block-' + this.conf.settings.index_version + '-' + indexPartition.toString().padStart(6, '0');

        // remove block
        try {
            const blockResult = await this.client.deleteByQuery({
                index: this.chain + '-block-' + this.conf.settings.index_version + '-*',
                refresh: true,
                ...searchBody
            });
            if (blockResult && blockResult.deleted && blockResult.deleted > 0) {
                hLog(`${blockResult.deleted} blocks removed from ${block_id}`);
            } else {
                if (blockResult.failures && blockResult.failures.length > 0) {
                    hLog('dbqResultBlock - Operation failed');
                    console.log(blockResult.failures);
                }
            }
        } catch (e: any) {
            hLog(`Error deleting block ${block_id}: ${e.message}`);
        }

        // remove deltas
        try {
            const dbqResultDelta = await this.client.deleteByQuery({
                index: this.chain + '-delta-' + this.conf.settings.index_version + '-*',
                refresh: true,
                ...searchBody
            });
            if (dbqResultDelta && dbqResultDelta.deleted && dbqResultDelta.deleted > 0) {
                hLog(`${dbqResultDelta.deleted} deltas removed from ${block_id}`);
            } else {
                if (dbqResultDelta.failures && dbqResultDelta.failures.length > 0) {
                    hLog('dbqResultDelta - Operation failed');
                    console.log(dbqResultDelta.failures);
                }
            }
        } catch (e: any) {
            hLog(`Error deleting deltas for block ${block_id}: ${e.message}`);
        }

        // remove actions
        try {
            const dbqResultAction = await this.client.deleteByQuery({
                index: this.chain + '-action-' + this.conf.settings.index_version + '-*',
                refresh: true,
                ...searchBody
            });
            if (dbqResultAction && dbqResultAction.deleted && dbqResultAction.deleted > 0) {
                hLog(`${dbqResultAction.deleted} traces removed from ${block_id}`);
            } else {
                if (dbqResultAction.failures && dbqResultAction.failures.length > 0) {
                    hLog('dbqResultAction - Operation failed');
                    console.log(dbqResultAction.failures);
                }
            }
        } catch (e: any) {
            hLog(`Error deleting actions for block ${block_id}: ${e.message}`);
        }
    }

    // private async handleFork(data: any) {
    //     const this_block = data['this_block'];
    //     await this.logForkEvent(this_block['block_num'], this.local_block_num, this_block['block_id']);
    //     hLog(`Handling fork event: new block ${this_block['block_num']} has id ${this_block['block_id']}`);
    //
    //     let targetBlock = this_block['block_num'];
    //     while (targetBlock < this.local_block_num + 1) {
    //         // fetch by block number to find the forked block_id
    //         const blockData = await this.client.get<any>({
    //             index: this.chain + '-block-' + this.conf.settings.index_version,
    //             id: targetBlock
    //         });
    //         targetBlock++;
    //         if (blockData) {
    //             const targetBlockId = blockData._source.block_id;
    //             this.forkedBlocks.set(targetBlockId, Date.now());
    //             console.log('forkedBlocks', this.forkedBlocks);
    //             try {
    //                 await this.deleteForkedBlock(targetBlockId);
    //             } catch (e: any) {
    //                 hLog(`Error deleting forked block ${targetBlockId}: ${e.message}`);
    //             }
    //         }
    //     }
    // }

    private async logForkEvent(starting_block: number, ending_block: number, new_id: string) {
        process.send?.({
            event: 'fork_event',
            data: {starting_block, ending_block, new_id}
        });
        await this.client.index({
            index: this.chain + '-logs-' + this.conf.settings.index_version,
            document: {
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

    // private startQueueWatcher() {
    //     setInterval(() => {
    //         if (this.isLiveReader) {
    //             this.manager.checkQueueSize(this.chain + ":live_blocks").then(value => {
    //                 if (value > this.conf.scaling.block_queue_limit) {
    //                     this.allowRequests = false;
    //                 } else {
    //                     this.allowRequests = true;
    //                     if (this.pendingRequest) {
    //                         this.processPending();
    //                     }
    //                 }
    //             });
    //         } else {
    //             let checkArr = [];
    //             for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
    //                 const q = this.chain + ":blocks:" + (i + 1);
    //                 checkArr.push(this.manager.checkQueueSize(q));
    //             }
    //             Promise.all(checkArr).then(data => {
    //                 if (data.some(el => el > this.conf.scaling.block_queue_limit)) {
    //                     if (this.allowRequests) {
    //                         hLog('ship reader paused!', data);
    //                     }
    //                     this.allowRequests = false;
    //                 } else {
    //                     this.allowRequests = true;
    //                     if (this.pendingRequest) {
    //                         this.processPending();
    //                     }
    //                 }
    //             });
    //         }
    //     }, this.queueSizeCheckInterval);
    // }

    private processPending() {
        if (this.pendingRequest) {
            hLog(`Processing pending request: ${this.pendingRequest[0]} - ${this.pendingRequest[1]}`);
            this.requestBlockRange(this.pendingRequest[0], this.pendingRequest[1]);
        }
        this.pendingRequest = null;
    }

    private startWS() {
        this.ship.connect(
            this.blockReadingQueue.push,
            this.handleLostConnection.bind(this),
            () => {
                hLog('connection failed');
            },
            () => {
                this.reconnectCount = 0;
            }
        );
    }

    private handleLostConnection() {
        this.recovery = true;
        this.ship.close(false);
        hLog(`Retrying connection in 5 seconds... [attempt: ${this.reconnectCount + 1}]`);
        debugLog(`PENDING REQUESTS:', ${this.pendingRequest}`);
        debugLog(`LOCAL BLOCK:', ${this.local_block_num}`);

        // switch to next endpoint if available
        this.ship.nextUrl();

        setTimeout(() => {
            this.reconnectCount++;
            this.startWS();
        }, 5000);
    }

    private emitCompletedSignal() {
        process.send?.({
            event: 'completed',
            id: process.env['worker_id']
        });
    }

    private logForkedBlocks(removedList: any[]) {
        const logData = removedList.map((block: any) => {
            return {
                block_id: block.block_id,
                block_num: block.block_num,
                timestamp: new Date(block.timestamp).toISOString()
            };
        });
        console.table(logData);
        process.send?.({
            event: 'forked_blocks',
            data: logData
        });
    }
}
