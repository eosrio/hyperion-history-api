import WebSocket from 'ws';
import {cargo, QueueObject} from 'async';
import {ConfirmChannel} from 'amqplib';
import {API, Bytes, Checksum256, Serializer, UInt32} from '@wharfkit/antelope';
import {protocolNumber} from '../protocol/contract-cache.js';

import {HyperionWorker, protocolSourceCapture} from './hyperionWorker.js';
import {createHash, randomUUID} from 'node:crypto';
import {ProtocolSourceBindingStore, protocolSourceSelectionHeader, type ProtocolSourcePosition} from '../protocol/source-bindings.js';
import {ProtocolAbiCoordinatorRpc} from '../protocol/abi-coordinator-rpc.js';
import {debugLog, hLog} from '../helpers/common_functions.js';
import {RabbitQueueDef} from '../definitions/index-queues.js';
import {LiveReaderCheckpoint, ReaderConfirmRange} from '../helpers/reader-progress.js';
import {actionSourceIngressHeader} from '../history/action-source-admission.js';
import type {ProtocolShipSession} from '@eosrio/hyperion-sdk/protocol';

interface RequestRange {
    first_block: number;
    last_block: number;
}

interface BlockInfo {
    block_num: UInt32;
    block_id: Checksum256;
}

class StaleProtocolIngress extends Error {}
class RevokedProtocolSource extends Error {}
type ProtocolIngress = {generation: number; kind: 'connected'} | {generation: number; kind: 'frame'; data: Buffer}
    | {generation?: number; kind: 'source-probe'; requestId: string; readerSessionId: string;
        coordinatorGeneration: string; source: ProtocolSourcePosition};
interface ShipCreditOwner {generation?: number; epoch: object; session?: ProtocolShipSession}

export interface GetBlocksResultV0 {
    head: BlockInfo;
    last_irreversible: BlockInfo;
    this_block: BlockInfo;
    prev_block: BlockInfo | null;
    block: Bytes;
    traces: Bytes;
    deltas: Bytes;
}

export default class StateReader extends HyperionWorker {
    private get usesOrderedSourceIngress(): boolean {return this.usesProtocolSourceBindings || this.actionSourceAdmissionEnabled;}
    private actionSourceSession?: {readerSessionId: string; schemaJson: string; generation?: number; verified: boolean};
    private readonly isLiveReader = process.env['worker_role'] === 'continuous_reader';
    private readonly baseRequest: any;

    private shipABI?: string;
    private protocolSourceBindingStore?: ProtocolSourceBindingStore;
    private sourceContext?: {id: string; schemaJson: string; readerSessionId: string; generation?: number};
    private socketGeneration = 0;
    private physicalIngressGeneration?: number;
    private activeIngressGeneration?: number;
    private verifiedReaderSessionId?: string;
    private coordinatorRpc?: ProtocolAbiCoordinatorRpc;
    private coordinatorSource?: {readerSessionId: string; generation?: string};
    private coordinatorResumeFromBlock?: number | null;

    private recovery = false;
    private allowRequests = true;
    private backpressurePaused = false;
    private shipCreditEpoch: object = {};
    private withheldShipCredits?: {owner: ShipCreditOwner; count: number};
    private legacyCreditGenerations = new WeakMap<object, number>();
    private pendingRequest: [number, number] | null = null;
    private completionSignaled = false;
    private assignmentId = process.env.reader_assignment;
    private rangeRequested = false;
    private confirmRange?: ReaderConfirmRange;
    private publications = new Map<object, {publisher: ConfirmChannel; deadline: number}>();
    private confirmationDeadline?: NodeJS.Timeout;
    private confirmationDeadlineAt?: number;
    private publisherFailure?: string;
    private finishing = false;
    private liveCheckpoint?: LiveReaderCheckpoint;
    private stageOneDistQueue: QueueObject<any>;
    private pendingDistribution?: {publisher: ConfirmChannel; resume: () => void};
    private blockReadingQueue: QueueObject<any>;
    private readonly sourceProbes = new Set<string>();
    private range_size = parseInt(process.env.last_block ?? '0') - parseInt(process.env.first_block ?? '0');
    private completionMonitoring: NodeJS.Timeout | null | undefined;

    private local_block_num = parseInt(process.env.first_block ?? '0', 10) - 1;
    private local_block_id = '';

    // private queueSizeCheckInterval = 5000;

    private local_distributed_count = 0;
    private local_last_block = 0;
    private reconnectCount = 0;
    private reconnectTimer?: NodeJS.Timeout;
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
            this.liveCheckpoint = new LiveReaderCheckpoint(this.local_block_num + 1, process.env.worker_last_processed_block_id,
                this.conf.settings.reader_recovery_window_blocks);
        }
        if (!this.isLiveReader) this.confirmRange = new ReaderConfirmRange(
            parseInt(process.env.first_block ?? '0', 10), parseInt(process.env.last_block ?? '0', 10));

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


    }

    distribute(data: any[], cb: () => void) {
        if (this.cch) {
            this.recursiveDistribute(data, this.cch, cb);
        }
    }

    recursiveDistribute(data: any[], channel: ConfirmChannel, cb: () => void) {
        if (data.length > 0) {
            const q = this.isLiveReader ? this.chain + ':live_blocks' : this.chain + ':blocks:' + this.currentIdx;
            if (this.cch_ready && channel === this.cch) {
                const d = data.pop();
                const range = this.confirmRange;
                const token = range?.accepted() ?? {};
                // Record ownership before calling sendToQueue: a callback may
                // fail synchronously and channel replacement cannot erase it.
                this.publications ??= new Map();
                this.publications.set(token, {publisher: channel, deadline: performance.now() + 60000});
                this.scheduleConfirmationDeadline();
                let result: boolean;
                try {
                    result = channel.sendToQueue(
                    q,
                    d.content,
                    {
                        persistent: true,
                        mandatory: true,
                        ...(d.headers ? {headers: d.headers} : {})
                    },
                    (err: any) => {
                        if (!this.publications.delete(token) || this.publisherFailure) return;
                        this.scheduleConfirmationDeadline();
                        const successful = !err && channel === this.cch;
                        range?.settle(token, d.num, successful);
                        if (err) {
                            this.failPublisherRecovery(`Block ${d.num} confirmation failed: ${err?.message ?? 'unknown confirmation'}`, {predicate: 'confirmation_failed', publisher: channel, blockNum: d.num});
                        } else if (!successful) {
                            this.failPublisherRecovery(`Block ${d.num} confirmed by a replaced publisher`, {predicate: 'confirmation_publisher_replaced', publisher: channel, blockNum: d.num});
                        } else {
                            if (range && range !== this.confirmRange) return;
                            try {
                                const checkpoint = d.confirmLive?.();
                                if (checkpoint) process.send?.({event: 'live_checkpoint', data: checkpoint});
                            } catch (error: any) {
                                this.failSourceRecovery(error.message);
                                return;
                            }
                            if (process.send) {
                                process.send({
                                    event: 'read_block',
                                    live: this.isLiveReader,
                                    block_num: d.num
                                });
                            }
                            if (range === this.confirmRange && range?.complete) this.signalReaderCompletion();
                        }
                    }
                );
                } catch (error: any) {
                    this.publications.delete(token);
                    range?.settle(token, d.num, false);
                    this.failPublisherRecovery(`Block ${d.num} publish failed: ${error.message}`, {predicate: 'publication_threw', publisher: channel, blockNum: d.num});
                    return;
                }

                if (!this.isLiveReader) {
                    this.local_distributed_count++;
                    debugLog(`Block Number: ${d.num} - Range progress: ${this.local_distributed_count}/${this.range_size}`);
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
                    // The message was accepted into the publisher buffer.
                    // Wait for that channel to drain before sending more.
                    this.drainCount++;
                    const pending = {
                        publisher: channel,
                        resume: () => {
                            if (this.pendingDistribution !== pending || !this.cch || !this.cch_ready) return;
                            this.pendingDistribution = undefined;
                            // data contains only messages not yet accepted by
                            // sendToQueue; the popped message is never retried.
                            this.recursiveDistribute(data, this.cch, cb);
                        }
                    };
                    this.pendingDistribution = pending;
                    channel.once('drain', () => {
                        if (channel === this.cch && this.cch_ready) {
                            pending.resume();
                        }
                    });
                }
            } else {
                console.log('channel is not ready!');
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
            } else {
                for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
                    await this.ch.assertQueue(this.chain + ':blocks:' + (i + 1), RabbitQueueDef);
                }
            }
        }

        if (this.cch) {
            const publisher = this.cch;
            if (Array.from(this.publications?.values() ?? []).some(publication => publication.publisher !== publisher)) {
                this.failPublisherRecovery('Publisher replaced with unknown block confirmations', {predicate: 'pending_publisher_replaced', publisher});
                return;
            }
            this.cch_ready = true;
            publisher.on('close', () => {
                if (publisher !== this.cch) return;
                this.cch_ready = false;
                this.stageOneDistQueue.pause();
                if (this.finishing) return;
                // Channel-only loss also needs supervision when no pending
                // callback is available to report the failure.
                if (this.publications?.size) this.failPublisherRecovery('Block publisher channel closed with unknown confirmations', {predicate: 'publisher_closed_pending', publisher});
                else {
                    // A full connection reconnect can replace a clean publisher.
                    // A channel-only close has no such reconnect in amqplib.
                    setTimeout(() => {
                        if (publisher === this.cch && !this.cch_ready) this.failPublisherRecovery('Block publisher channel remained closed', {predicate: 'publisher_remained_closed', publisher});
                    }, 1000).unref();
                }
            });
            publisher.on('error', (error: Error) => {
                if (publisher === this.cch) this.failPublisherRecovery(`Block publisher error: ${error.message}`, {predicate: 'publisher_error', publisher});
            });
            publisher.on('return', () => {
                if (publisher === this.cch) this.failPublisherRecovery('Mandatory block publication was unroutable', {predicate: 'publication_returned', publisher});
            });
            this.stageOneDistQueue.resume();
            // resume() only starts queued cargo; a batch already waiting on an
            // old publisher's drain needs its own continuation after reconnect.
            const pending = this.pendingDistribution;
            if (pending && pending.publisher !== publisher) pending.resume();
        }
    }

    newRange(data: any) {

        if (data.assignment_id && data.assignment_id === this.assignmentId && this.rangeRequested) return;
        if (this.publications?.size) {
            this.failPublisherRecovery('Range replaced with unknown block confirmations', {predicate: 'range_replaced_pending'});
            return;
        }
        this.rangeRequested = true;

        debugLog(`new_range [${data.first_block},${data.last_block}]`);

        this.local_distributed_count = 0;
        if (this.completionMonitoring) {
            clearInterval(this.completionMonitoring);
        }

        this.completionMonitoring = null;
        this.completionSignaled = false;
        this.local_last_block = data.last_block;
        if (data.assignment_id) this.assignmentId = data.assignment_id;

        // make sure no data is requested from before the first indexed block on ship
        if (!this.sourceRangeAvailable(parseInt(data.first_block))) {
            this.failSourceRecovery(`Requested block ${data.first_block} precedes SHIP retention ${this.shipInitStatus['trace_begin_block']}`);
            return;
        }

        this.range_size = parseInt(data.last_block) - parseInt(data.first_block);
        this.confirmRange = new ReaderConfirmRange(parseInt(data.first_block), parseInt(data.last_block));

        // if range size is not positive, we need to immediately signal completion to master
        if (this.range_size <= 0) {
            this.emitCompletedSignal();
            return;
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
                start = e;
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
        if (this.coordinatorRpc?.onMessage(msg)) return;
        switch (msg.event) {
            case 'protocol_source_probe_request': {
                const request = msg.data, source = request?.source;
                if (!this.isLiveReader || !this.usesProtocolSourceBindings || typeof request?.requestId !== 'string'
                    || typeof request.readerSessionId !== 'string' || typeof request.generation !== 'string'
                    || source?.chainId !== this.chainId || !Number.isSafeInteger(source.blockNum)
                    || typeof source.blockId !== 'string' || (source.previousBlockId !== null && typeof source.previousBlockId !== 'string')) break;
                if (this.sourceProbes.size >= 32 || this.sourceProbes.has(request.requestId)) {
                    process.send?.({event: 'protocol_source_probe_reply', data: {requestId: request.requestId,
                        readerSessionId: request.readerSessionId, generation: request.generation, current: false}});
                    break;
                }
                // This barrier follows already queued physical SHIP frames, including a replacement fork.
                this.sourceProbes.add(request.requestId);
                void this.blockReadingQueue.push({kind: 'source-probe', generation: this.physicalIngressGeneration,
                    requestId: request.requestId, readerSessionId: request.readerSessionId,
                    coordinatorGeneration: request.generation, source} satisfies ProtocolIngress)
                    .catch(console.log).finally(() => this.sourceProbes.delete(request.requestId));
                break;
            }
            case 'new_range': {
                if (msg.target === process.env.worker_id) {
                    this.newRange(msg.data);
                }
                break;
            }
            case 'pause': {
                this.backpressurePaused = true;
                this.allowRequests = false;
                break;
            }
            case 'resume': {
                if (this.finishing || this.publisherFailure) break;
                this.backpressurePaused = false;
                this.allowRequests = true;
                this.flushShipCredits();
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
                if (this.usesOrderedSourceIngress) this.revokeCoordinatorSource();
                // A deliberate switch initiates recovery; the old close callback is fenced.
                this.handleLostConnection();
                break;
            }
            case 'stop': {
                if (this.isLiveReader) {
                    hLog('[LIVE READER] Closing Websocket');
                    this.finishing = true;
                    this.physicalIngressGeneration = undefined;
                    this.clearProtocolReconnect();
                    this.revokeCoordinatorSource();
                    this.ship.close(true);
                    setTimeout(() => {
                        hLog('[LIVE READER] Process killed');
                        process.exit(1);
                    }, 2000);
                }
                break;
            }
            case 'finish': {
                if (!this.isLiveReader && msg.target === process.env.worker_id) {
                    void this.finishReader().then(() => process.exit(0)).catch(error => {
                        hLog(`Reader failed to finish cleanly: ${error.message}`);
                        process.exit(1);
                    });
                }
                break;
            }
        }
    }

    async run(): Promise<void> {
        // this.startQueueWatcher();
        this.events.once('ready', () => {
            this.startWS();
        });
    }

    private scheduleConfirmationDeadline() {
        // Map insertion order follows publication time. Settling a newer token
        // cannot extend the deadline of an older, still-unconfirmed block.
        const oldest = this.publications?.values().next().value;
        if (oldest && this.confirmationDeadline && this.confirmationDeadlineAt === oldest.deadline) return;
        if (this.confirmationDeadline) clearTimeout(this.confirmationDeadline);
        this.confirmationDeadline = undefined;
        this.confirmationDeadlineAt = undefined;
        if (!oldest || this.publisherFailure) return;
        this.confirmationDeadlineAt = oldest.deadline;
        const timer = setTimeout(() => {
            if (this.confirmationDeadline !== timer) return;
            this.confirmationDeadline = undefined;
            this.confirmationDeadlineAt = undefined;
            const pending = this.publications.values().next().value;
            if (pending && pending.deadline <= performance.now()) {
                this.failPublisherRecovery('Block publisher confirmation deadline exceeded (60000ms)', {predicate: 'confirmation_deadline', publisher: pending.publisher});
            } else this.scheduleConfirmationDeadline();
        }, Math.max(0, oldest.deadline - performance.now())).unref();
        this.confirmationDeadline = timer;
    }

    async finishReader(): Promise<void> {
        const deadline = performance.now() + 10000;
        this.finishing = true;
        this.allowRequests = false;
        this.clearProtocolReconnect();
        this.revokeCoordinatorSource();
        this.ship.close(true);
        while (!this.stageOneDistQueue.idle() || this.publications.size || !this.blockReadingQueue.idle()) {
            if (this.publisherFailure) throw new Error(this.publisherFailure);
            if (performance.now() >= deadline) throw new Error('Reader finish deadline exceeded');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        if (this.publisherFailure || !this.confirmRange?.complete) throw new Error(this.publisherFailure ?? 'Reader range is incomplete');
        if (this.completionMonitoring) clearInterval(this.completionMonitoring);
        this.profiler.stopReporting();
        for (const channel of [this.cch, this.ch]) {
            if (!channel) continue;
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw new Error('Reader finish deadline exceeded');
            let timeout: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    new Promise<never>((_resolve, reject) => {
                        timeout = setTimeout(() => reject(new Error('Reader finish deadline exceeded')), remaining);
                    }),
                    channel.close()
                ]);
            } finally {
                if (timeout) clearTimeout(timeout);
            }
        }
    }

    private signalReaderCompletion() {
        if (!this.completionSignaled) {
            this.completionSignaled = true;
            debugLog(`Reader completion signal - ${this.range_size} - ${this.local_distributed_count}`);
            this.completionMonitoring = setInterval(() => {
                if (!this.publisherFailure && this.confirmRange?.complete && this.stageOneDistQueue.idle()) {
                    debugLog(`Reader completed - ${this.range_size} - ${this.local_distributed_count}`);

                    if (this.completionMonitoring) {
                        clearInterval(this.completionMonitoring);
                    }

                    // check if there are any pending ranges, then signal completion to master
                    if (this.internalPendingRanges.length === 0) {
                        this.emitCompletedSignal();
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
        if (this.usesOrderedSourceIngress && block_array.some(item => item?.kind === 'frame' || item?.kind === 'connected' || item?.kind === 'source-probe')) {
            let credits = 0;
            let creditGeneration: number | undefined;
            let creditOwner: ShipCreditOwner | undefined;
            for (const item of block_array as ProtocolIngress[]) {
                if (item.kind === 'connected') {
                    if (item.generation !== this.physicalIngressGeneration) continue;
                    this.invalidateShipCredits();
                    this.shipABI = undefined;
                    this.sourceContext = undefined;
                    this.actionSourceSession = undefined;
                    this.verifiedReaderSessionId = undefined;
                    this.shipSession?.close?.();
                    this.shipSession = undefined;
                    credits = 0;
                    creditOwner = undefined;
                    creditGeneration = item.generation;
                    continue;
                }
                if (item.kind === 'source-probe') {
                    const position = {num: item.source.blockNum, id: item.source.blockId,
                        previous: item.source.previousBlockId ?? ''};
                    const current = item.generation !== undefined && item.generation === this.physicalIngressGeneration
                        && this.verifiedReaderSessionId === item.readerSessionId
                        && this.coordinatorSource?.readerSessionId === item.readerSessionId
                        && this.coordinatorSource.generation === item.coordinatorGeneration
                        && !!this.liveCheckpoint?.hasCurrentReversible(position);
                    process.send?.({event: 'protocol_source_probe_reply', data: {requestId: item.requestId,
                        readerSessionId: item.readerSessionId, generation: item.coordinatorGeneration, current}});
                    continue;
                }
                if (item.kind !== 'frame' || !Buffer.isBuffer(item.data)) throw new Error('Invalid protocol ingress envelope');
                if (item.generation !== this.physicalIngressGeneration) {
                    await this.quarantineIngress(item.data, 'Reader frame belongs to a disconnected socket');
                    continue;
                }
                this.activeIngressGeneration = item.generation;
                try {
                    const owner = this.shipCreditOwner(item.generation);
                    const kind = await this.onMessage(item.data);
                    this.assertCurrentIngress();
                    if (kind === 'block') {
                        if (creditGeneration !== item.generation || (creditOwner && !this.sameShipCreditOwner(creditOwner, owner))) credits = 0;
                        creditGeneration = item.generation;
                        creditOwner = owner;
                        credits++;
                    }
                } catch (error) {
                    if (error instanceof RevokedProtocolSource) {
                        await this.quarantineIngress(item.data, error.message, 'protocol_reader_coordinator_stale');
                        throw error;
                    }
                    if (!(error instanceof StaleProtocolIngress)) throw error;
                    await this.quarantineIngress(item.data, error.message);
                } finally { this.activeIngressGeneration = undefined; }
            }
            while (this.publications.size && !this.publisherFailure) await new Promise(resolve => setTimeout(resolve, 5));
            if (this.publisherFailure) throw new Error(this.publisherFailure);
            if (credits && creditOwner) this.returnShipCredits(credits, creditOwner);
            if (this.delay_active) await new Promise(resolve => setTimeout(resolve, this.block_processing_delay));
            return true;
        }
        // Legacy cargo keeps raw buffers, but their credit ownership is captured
        // at socket ingress, before a reconnect can leave old work in the queue.
        const generation = this.physicalIngressGeneration;
        const blocks = block_array.filter(block => {
            const original = this.legacyCreditGenerations?.get(block);
            return original === undefined || original === generation;
        });
        if (!blocks.length) return true;
        if (this.shipABI) {
            const owner = this.shipCreditOwner(generation);
            for (const block of blocks) {
                if (!this.currentShipCreditOwner(owner)) break;
                await this.onMessage(block);
            }
            // SHIP credit means accepted input has a successful broker confirm,
            // not merely that its bytes entered a client-side publisher buffer.
            while (this.publications.size && !this.publisherFailure) await new Promise(resolve => setTimeout(resolve, 5));
            if (this.publisherFailure) throw new Error(this.publisherFailure);
            this.returnShipCredits(blocks.length, owner);
        } else {
            await this.onMessage(blocks[0]);
            this.returnShipCredits(blocks.length, this.shipCreditOwner(generation));
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
            if (this.usesProtocolSourceBindings && this.recovery) {
                this.resumeReaderRecovery();
                return;
            }
            switch (process.env['worker_role']) {
                // range reader setup
                case 'reader': {
                    if (process.env.first_block && !this.sourceRangeAvailable(parseInt(process.env.first_block, 10))) {
                        this.failSourceRecovery(`Requested block ${process.env.first_block} precedes SHIP retention ${beingBlock}`);
                        return;
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

    /** Fetch eligibility only. Completeness still requires retained bytes and canonical provider verification. */
    private sourceRangeAvailable(firstBlock: number): boolean {
        const traceBegin = Number(this.shipInitStatus['trace_begin_block']);
        const stateBegin = Number(this.shipInitStatus['chain_state_begin_block'] ?? 0);
        if (firstBlock >= Math.max(traceBegin, stateBegin)) return true;
        return firstBlock === 1 && traceBegin === 2 && stateBegin === 1
            && Number(this.shipInitStatus['chain_state_end_block']) > 1
            && this.usesProtocolSourceBindings && typeof this.protocol.verifyNativeGenesis === 'function'
            && this.baseRequest.fetch_block === true && this.baseRequest.fetch_deltas === true;
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
                        if (protocolNumber(blockData.block_num) === val.block_num) {
                            // console.log(`Block ${protocolNumber(blockData.block_num)} ${block_id} is still present on the chain, not forked.`);
                            // check if the block is older than the last irreversible block
                            if (val.block_num <= this.local_lib) {
                                console.log(`Block ${block_id} is older than the lib, definitely not forked.`);
                                this.forkedBlocks.delete(block_id);
                            } else {
                                // check the current id for the same block number on the reversible block map
                                const currentBlockId = this.reversibleBlockMap.get(protocolNumber(blockData.block_num));
                                if (currentBlockId && currentBlockId !== block_id) {
                                    // handle as a forked block, since a new different id was received after the fork
                                    blockData = null;
                                } else {
                                    pendingList.push({block_id, ...val});
                                }
                            }
                        } else {
                            hLog(`[WARNING] Unexpected block number for ${block_id}: ${protocolNumber(blockData.block_num)} (expected: ${val.block_num})`);
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
            if (block_num <= protocolNumber(lib.block_num)) {
                this.reversibleBlockMap.delete(block_num);
                // console.log(`Deleting reversible block ${block_num} with id ${block_id}`);
            }
        });
    }

    private async handleBlockResult(res: GetBlocksResultV0, data: Buffer) {
        if (res.this_block) {
            this.idle = false;
            const blk_num = protocolNumber(res.this_block.block_num);
            const blk_id = res.this_block.block_id.toString();
            const lib = res.last_irreversible;
            let confirmLive: (() => {nextBlock: number; blockId: string} | undefined) | undefined;
            try {
                const checkpoint = this.isLiveReader ? this.liveCheckpoint : undefined;
                if (checkpoint) {
                    const generation = this.physicalIngressGeneration, context = this.sourceContext;
                    const confirm = checkpoint.observe({num: blk_num, id: blk_id,
                        previous: res.prev_block?.block_id.toString() ?? ''}, protocolNumber(lib.block_num));
                    confirmLive = () => this.liveCheckpoint === checkpoint && this.physicalIngressGeneration === generation
                        && this.sourceContext === context ? confirm() : undefined;
                }
            } catch (error: any) {
                this.failSourceRecovery(error.message);
                return 0;
            }
            const task_payload = {
                num: blk_num,
                content: data,
                confirmLive,
                headers: {...(this.usesProtocolSourceBindings ? await this.bindProtocolSource(res, data) : {}),
                    ...(this.actionSourceAdmissionEnabled ? await this.bindActionSource(res, data) : {})}
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

                if (protocolNumber(lib.block_num) > this.local_lib) {
                    this.local_lib = protocolNumber(lib.block_num);
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

    private async onMessage(data: Buffer): Promise<'block' | 'other'> {
        if (!this.shipABI) {
            await this.processFirstABI(data);
            return 'other';
        }

        if (!process.env.worker_role) {
            hLog('[FATAL ERROR] undefined role! Exiting now!');
            this.ship.close(false);
            process.exit(1);
        }

        // NORMAL OPERATION MODE
        if (!this.recovery || this.usesOrderedSourceIngress) {
            const result = this.decodeShipResult(data);
            switch (result[0]) {
                case 'get_status_result_v0':
                case 'get_status_result_v1': {
                    if (this.actionSourceAdmissionEnabled) {
                        const session = this.actionSourceSession;
                        if (!session || result[1]?.chain_id?.toString().toLowerCase() !== this.chainId)
                            throw new Error('Action source SHiP session did not identify the configured chain');
                        this.assertCurrentIngress(session.generation); session.verified = true;
                    }
                    if (this.usesProtocolSourceBindings) {
                        const chainId = result[1]?.chain_id?.toString().toLowerCase();
                        if (!this.sourceContext || !/^[0-9a-f]{64}$/.test(chainId ?? '') || chainId !== this.chainId) {
                            this.verifiedReaderSessionId = undefined;
                            this.revokeCoordinatorSource();
                            await this.quarantineIngress(data, 'SHiP status does not identify the configured chain', 'protocol_reader_chain_unverified');
                            return 'other';
                        }
                        this.assertCurrentIngress(this.sourceContext.generation);
                        this.verifiedReaderSessionId = this.sourceContext.readerSessionId;
                        if (this.isLiveReader) await this.openCoordinatorSource();
                    }
                    this.handleStatusResult(result[1]);
                    break;
                }
                case 'get_blocks_result_v0':
                case 'get_blocks_result_v1': {
                    if (this.actionSourceAdmissionEnabled && !this.actionSourceSession?.verified)
                        throw new Error('Action source block arrived before chain verification');
                    if (this.usesProtocolSourceBindings && (!this.sourceContext || this.verifiedReaderSessionId !== this.sourceContext.readerSessionId)) {
                        await this.quarantineIngress(data, 'Block arrived before this connection identified the configured chain', 'protocol_reader_chain_unverified');
                        return 'other';
                    }
                    const published = await this.handleBlockResult(result[1], data);
                    if (this.usesProtocolSourceBindings && published !== 1) {
                        await this.quarantineIngress(data, 'Block response was not routed to a history worker', 'protocol_reader_unrouted_block');
                    }
                    // Every block-flow response consumes one source credit,
                    // including an unavailable block with no this_block position.
                    return 'block';
                }
                default: {
                    throw new Error(`Unsupported SHiP result: ${result[0]}`);
                }
            }
        } else {
            this.resumeReaderRecovery();
        }
        return 'other';
    }

    private resumeReaderRecovery(): void {
        if (this.isLiveReader) {
            hLog(`Resuming live stream from block ${this.local_block_num}...`);
            this.requestBlocks(this.local_block_num + 1);
            this.recovery = false;
        } else if (!this.completionSignaled) {
            let first = this.local_block_num;
            let last = this.local_last_block;
            if (last === 0 && process.env.last_block) last = parseInt(process.env.last_block, 10);
            last = last - 1;
            if (first === 0 && process.env.first_block) first = parseInt(process.env.first_block, 10);
            if (first > last) last = first + 1;
            hLog(`Resuming stream from block ${first} to ${last}...`);
            if (last - first > 0) {
                this.requestBlockRange(first, last);
                this.recovery = false;
            } else hLog('Invalid range!');
        } else {
            hLog('Reader already finished, no need to restart.');
            this.recovery = false;
        }
    }

    private async processFirstABI(data: Buffer) {
        const abiString = data.toString();
        const generation = this.activeIngressGeneration;
        this.assertCurrentIngress(generation);
        this.verifiedReaderSessionId = undefined;
        this.revokeCoordinatorSource();
        await this.initializeProtocolShip(abiString);
        this.assertCurrentIngress(generation);
        if (this.actionSourceAdmissionEnabled) this.actionSourceSession = {readerSessionId: randomUUID(), schemaJson: abiString, generation, verified: false};
        if (this.usesProtocolSourceBindings) {
            const stop = this.profiler.start('protocol_source_prepare_context');
            try {
                this.protocolSourceBindingStore ??= new ProtocolSourceBindingStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0);
                const context = await this.protocolSourceBindingStore.prepareContext({schemaVersion: 1, chainId: this.chainId,
                    protocol: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []}, schemaJson: abiString});
                this.assertCurrentIngress(generation);
                this.sourceContext = {id: context.id, schemaJson: abiString, readerSessionId: randomUUID(), generation};
            } finally { stop(); }
        }
        this.shipABI = abiString;
        const requestAbi = JSON.parse(abiString).structs?.find(struct => struct.name === 'get_blocks_request_' + this.shipRev);
        for (const field of requestAbi?.fields ?? []) {
            if (field.type === 'bool' && /^fetch_/.test(field.name) && !Object.hasOwn(this.baseRequest, field.name)) {
                this.baseRequest[field.name] = field.name === 'fetch_block_header';
            }
        }
        process.send?.({event: 'init_abi', data: abiString});
        // request status
        this.send(['get_status_request_v0', {}]);
    }

    private async bindActionSource(result: GetBlocksResultV0, frame: Buffer): Promise<Record<string, string>> {
        const session = this.actionSourceSession;
        if (!session?.verified) throw new Error('Action source ingress lacks a verified original session');
        this.assertCurrentIngress(session.generation);
        const capture = protocolSourceCapture(this.chainId, result, session.schemaJson);
        const id = await this.getActionAdmissionStore().retainIngress({schemaVersion: 1, chainId: this.chainId,
            protocolId: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? [],
            readerSessionId: session.readerSessionId, schemaJson: session.schemaJson, frameHex: frame.toString('hex'), captureSha256: capture.captureSha256});
        this.assertCurrentIngress(session.generation);
        if (this.actionSourceSession !== session) throw new Error('Action source session changed during retention');
        return {[actionSourceIngressHeader]: id};
    }

    private async bindProtocolSource(result: GetBlocksResultV0, frame: Buffer): Promise<Record<string, string>> {
        // Snapshot before awaiting storage: reconnects cannot rebind queued bytes.
        const context = this.sourceContext;
        if (!context || !this.protocolSourceBindingStore) throw new Error('Reader source context is not durably initialized');
        if (this.verifiedReaderSessionId !== context.readerSessionId) throw new Error('Reader source chain is not verified for this session');
        this.assertCurrentIngress(context.generation);
        const stop = this.profiler.start('protocol_source_prepare_selection');
        try {
            const capture = protocolSourceCapture(this.chainId, result, context.schemaJson);
            const position = (value: BlockInfo) => ({blockNum: protocolNumber(value?.block_num),
                blockId: value?.block_id?.toString().toLowerCase() ?? ''});
            const selection = await this.protocolSourceBindingStore.prepareSelection({schemaVersion: 1, contextId: context.id,
                readerSessionId: context.readerSessionId, readerRole: this.isLiveReader ? 'live' : this.repairMode ? 'repair' : 'bulk',
                assignmentId: this.assignmentId ?? null, source: capture.source,
                frameSha256: createHash('sha256').update(frame).digest('hex'), captureSha256: capture.captureSha256,
                head: position(result.head), irreversible: position(result.last_irreversible)});
            this.assertCurrentIngress(context.generation);
            if (this.isLiveReader) await this.admitCoordinatorSelection(selection.id, context.readerSessionId, context.generation);
            return {[protocolSourceSelectionHeader]: selection.id};
        } finally { stop(); }
    }

    private async openCoordinatorSource(): Promise<void> {
        const context = this.sourceContext;
        if (!context || this.verifiedReaderSessionId !== context.readerSessionId) throw new Error('Cannot coordinate an unverified reader source');
        if (this.coordinatorSource?.readerSessionId === context.readerSessionId && this.coordinatorSource.generation) return;
        this.coordinatorRpc ??= new ProtocolAbiCoordinatorRpc();
        const source = {readerSessionId: context.readerSessionId, generation: undefined as string | undefined};
        this.coordinatorSource = source;
        const stop = this.profiler.start('protocol_abi_open_source');
        try {
            const opened = await this.coordinatorRpc.open(context.id, context.readerSessionId);
            this.assertCurrentIngress(context.generation);
            if (this.coordinatorSource !== source) throw new StaleProtocolIngress('Reader source changed while coordinator opened');
            source.generation = opened.generation;
            this.coordinatorResumeFromBlock = opened.resumeFromBlock;
            if (opened.resumeFromBlock !== null) {
                const published = this.liveCheckpoint?.resumePoint();
                const resume = published ? Math.min(published.nextBlock, opened.resumeFromBlock) : opened.resumeFromBlock;
                this.coordinatorResumeFromBlock = resume;
                this.local_block_num = resume - 1;
                // This is a new local publication epoch, not a fabricated master checkpoint.
                // ABI coverage cannot skip publication recovery; only fresh confirmed irreversible
                // publications advance this cursor. Preserve its anchor when both starts agree.
                this.liveCheckpoint = new LiveReaderCheckpoint(resume, published?.nextBlock === resume ? published.blockId : '',
                    this.conf.settings.reader_recovery_window_blocks);
            }
        } catch (error) {
            this.assertCurrentIngress(context.generation);
            throw error;
        } finally { stop(); }
    }

    private async admitCoordinatorSelection(selectionId: string, readerSessionId: string, generation?: number): Promise<void> {
        const source = this.coordinatorSource;
        if (!source?.generation || source.readerSessionId !== readerSessionId || !this.coordinatorRpc) throw new RevokedProtocolSource('Live source lacks coordinator authority');
        for (;;) {
            this.assertCurrentIngress(generation);
            if (this.coordinatorSource !== source) throw new StaleProtocolIngress('Reader source changed during admission');
            const stop = this.profiler.start('protocol_abi_admit_source');
            let admitted;
            try { admitted = await this.coordinatorRpc.admit(selectionId, readerSessionId, source.generation); }
            catch (error) { this.assertCurrentIngress(generation); throw error; }
            finally { stop(); }
            this.assertCurrentIngress(generation);
            if (this.coordinatorSource !== source) throw new StaleProtocolIngress('Reader source changed during admission');
            if (admitted.status === 'stale') throw new RevokedProtocolSource('Coordinator revoked this source generation');
            if (admitted.status === 'accepted') { source.generation = admitted.generation; return; }
            // One retained selection waits at the reader. No master queue waiter or extra frame is created.
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    private revokeCoordinatorSource(): void {
        this.invalidateShipCredits();
        const source = this.coordinatorSource;
        this.coordinatorSource = undefined;
        this.coordinatorResumeFromBlock = undefined;
        this.coordinatorRpc?.cancel();
        if (source) process.send?.({event: 'protocol_abi_source_revoked', data: {readerSessionId: source.readerSessionId,
            ...(source.generation ? {generation: source.generation} : {})}});
    }

    private assertCurrentIngress(generation = this.activeIngressGeneration): void {
        if (this.usesOrderedSourceIngress && this.socketGeneration && generation !== this.physicalIngressGeneration) {
            throw new StaleProtocolIngress('Reader socket changed while source capture was pending');
        }
    }

    private async quarantineIngress(frame: Buffer, message: string, code = 'protocol_reader_stale_ingress'): Promise<void> {
        if (this.actionSourceAdmissionEnabled && !this.usesProtocolSourceBindings) {
            const id = await this.getActionAdmissionStore().retainRejectedIngress({chainId: this.chainId, protocolId: this.protocolId,
                profileId: this.protocol.profileId, frameHex: frame.toString('hex'), reason: {code, message}});
            process.send?.({event: 'ds_error', data: {type: 'action_source_incomplete', code, capsuleId: id}});
            return;
        }
        this.protocolSourceBindingStore ??= new ProtocolSourceBindingStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0);
        const stop = this.profiler.start('protocol_source_quarantine');
        try {
            const capsule = await this.protocolSourceBindingStore.quarantine({schemaVersion: 1, chainId: this.chainId,
                protocol: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []},
                frameHex: frame.toString('hex'), claimedSelectionId: null, reason: {code, message}});
            process.send?.({event: 'ds_error', data: {type: 'protocol_source_incomplete', code, capsuleId: capsule.id}});
        } finally { stop(); }
    }

    private requestBlocks(start: number) {
        if (this.usesProtocolSourceBindings && this.isLiveReader) {
            if (!this.coordinatorSource?.generation) return;
            if (this.coordinatorResumeFromBlock !== null && this.coordinatorResumeFromBlock !== undefined) start = this.coordinatorResumeFromBlock;
            this.coordinatorResumeFromBlock = undefined;
        }
        this.rangeRequested = true;
        let first_block: string | number = start > 0 ? start : process.env.first_block ? process.env.first_block : 1;
        const last_block = start > 0 ? 0xffffffff : process.env.last_block ? process.env.last_block : 0xffffffff;
        const request = this.baseRequest;
        if (this.isLiveReader && this.usesProtocolSourceBindings) {
            request.have_positions = [];
        } else if (this.isLiveReader && process.env.worker_last_processed_block_id) {
            request.have_positions = [{block_num: Number(process.env.worker_last_processed_block) - 1,
                block_id: process.env.worker_last_processed_block_id}];
        }
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

    private send(req_data: (string | any)[], generation = this.activeIngressGeneration ?? this.sourceContext?.generation ?? this.actionSourceSession?.generation) {
        if (this.usesProtocolSourceBindings && /^get_blocks_request_/.test(req_data[0])
            && (!this.sourceContext || this.verifiedReaderSessionId !== this.sourceContext.readerSessionId)) return;
        if (this.actionSourceAdmissionEnabled && /^get_blocks_request_/.test(req_data[0]) && !this.actionSourceSession?.verified) return;
        // Commands and credits from an old await must never reach a new physical socket.
        if (this.usesOrderedSourceIngress && this.socketGeneration
            && (generation === undefined || generation !== this.physicalIngressGeneration)) return;
        this.ship.send(
            this.shipSession!.encodeRequest(req_data)
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

    private shipCreditOwner(generation = this.physicalIngressGeneration): ShipCreditOwner {
        return {generation, epoch: this.shipCreditEpoch ??= {}, session: this.shipSession};
    }

    private sameShipCreditOwner(left: ShipCreditOwner, right: ShipCreditOwner): boolean {
        return left.generation === right.generation && left.epoch === right.epoch && left.session === right.session;
    }

    private currentShipCreditOwner(owner: ShipCreditOwner): boolean {
        return !this.finishing && !this.publisherFailure && this.ship.connected !== false
            && this.sameShipCreditOwner(owner, this.shipCreditOwner())
            && (!this.socketGeneration || owner.generation === this.socketGeneration);
    }

    private invalidateShipCredits(): void {
        this.shipCreditEpoch = {};
        this.withheldShipCredits = undefined;
    }

    /** Confirmed input retains one bounded counter, never a waiter in the cargo loop. */
    private returnShipCredits(count: number, owner: ShipCreditOwner): void {
        if (!Number.isInteger(count) || count < 1 || count > 0xffffffff) throw new Error('Invalid SHIP credit count');
        if (!this.currentShipCreditOwner(owner)) return;
        const pending = this.withheldShipCredits;
        const total = count + (pending && this.sameShipCreditOwner(pending.owner, owner) ? pending.count : 0);
        if (total > 0xffffffff) throw new Error('Withheld SHIP credit count exceeds uint32');
        this.withheldShipCredits = {owner, count: total};
        this.flushShipCredits();
    }

    private flushShipCredits(): void {
        if (this.backpressurePaused) return;
        const pending = this.withheldShipCredits;
        // Clear before encoding/sending: duplicate resumes or synchronous socket
        // callbacks cannot return the same accepted-input credit twice.
        this.withheldShipCredits = undefined;
        if (pending && this.currentShipCreditOwner(pending.owner))
            this.send(['get_blocks_ack_request_v0', {num_messages: pending.count}], pending.owner.generation);
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
        if (this.finishing || this.publisherFailure) return;
        const generation = ++this.socketGeneration;
        this.physicalIngressGeneration = undefined;
        this.invalidateShipCredits();
        if (this.usesOrderedSourceIngress) {
            this.clearProtocolReconnect();
            this.revokeCoordinatorSource();
            this.ship.connect(
                (data: any) => { void this.blockReadingQueue.push({kind: 'frame', generation, data: Buffer.from(data)}).catch(console.log); },
                () => {
                    if (this.physicalIngressGeneration !== generation) return;
                    this.physicalIngressGeneration = undefined;
                    this.revokeCoordinatorSource();
                    this.handleLostConnection();
                },
                () => { hLog('connection failed'); },
                () => {
                    if (generation !== this.socketGeneration) return;
                    this.reconnectCount = 0;
                    this.physicalIngressGeneration = generation;
                    void this.blockReadingQueue.push({kind: 'connected', generation}).catch(console.log);
                });
            return;
        }
        // Before open there is no physical ingress owner yet. The attempt's
        // epoch distinguishes its first failure from a retired socket callback.
        const attemptEpoch = this.shipCreditEpoch;
        let opened = false;
        const currentAttempt = () => generation === this.socketGeneration && !this.finishing && !this.publisherFailure
            && (opened ? this.physicalIngressGeneration === generation : this.shipCreditEpoch === attemptEpoch);
        this.ship.connect(
            (data: any) => {
                // Distinct delivery identity without copying a ws-owned Buffer.
                const frame = Buffer.isBuffer(data) ? data.subarray() : Buffer.from(data);
                (this.legacyCreditGenerations ??= new WeakMap()).set(frame, generation);
                void this.blockReadingQueue.push(frame).catch(console.log);
            },
            () => {
                if (!currentAttempt()) return;
                this.physicalIngressGeneration = undefined;
                this.invalidateShipCredits();
                this.handleLostConnection();
            },
            () => {
                hLog('connection failed');
            },
            () => {
                if (opened || !currentAttempt()) return;
                opened = true;
                this.physicalIngressGeneration = generation;
                this.reconnectCount = 0;
                this.shipABI = undefined;
                this.sourceContext = undefined;
                this.shipSession?.close?.();
                this.shipSession = undefined;
            }
        );
    }

    private clearProtocolReconnect(): void {
        if (!this.usesOrderedSourceIngress) return;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
    }

    private handleLostConnection() {
        this.invalidateShipCredits();
        this.physicalIngressGeneration = undefined;
        if (this.usesOrderedSourceIngress && (this.reconnectTimer || this.finishing || this.publisherFailure)) return;
        this.recovery = true;
        this.ship.close(false);
        hLog(`Retrying connection in 5 seconds... [attempt: ${this.reconnectCount + 1}]`);
        debugLog(`PENDING REQUESTS:', ${this.pendingRequest}`);
        debugLog(`LOCAL BLOCK:', ${this.local_block_num}`);

        // switch to next endpoint if available
        this.ship.nextUrl();

        const reconnect = () => {
            if (this.usesOrderedSourceIngress) {
                this.reconnectTimer = undefined;
                if (this.finishing || this.publisherFailure) return;
            }
            this.reconnectCount++;
            this.startWS();
        };
        if (this.usesOrderedSourceIngress) this.reconnectTimer = setTimeout(reconnect, 5000);
        else setTimeout(reconnect, 5000);
    }

    private emitCompletedSignal() {
        process.send?.({
            event: 'completed',
            id: process.env['worker_id'],
            assignment_id: this.assignmentId
        });
    }

    private failPublisherRecovery(reason: string, decision: {predicate: string; publisher?: ConfirmChannel; blockNum?: number}) {
        if (this.publisherFailure) return;
        this.publisherFailure = reason;
        this.cch_ready = false;
        this.stageOneDistQueue.pause();
        this.blockReadingQueue?.pause();
        if (this.completionMonitoring) clearInterval(this.completionMonitoring);
        if (this.confirmationDeadline) clearTimeout(this.confirmationDeadline);
        this.confirmationDeadline = undefined;
        this.confirmationDeadlineAt = undefined;
        this.clearProtocolReconnect();
        this.revokeCoordinatorSource();
        process.send?.({event: 'reader_recovery_required', error: reason, assignment_id: this.assignmentId});
        hLog(`Reader publication outcome incomplete; supervised source replay required: ${reason}`);
        this.ship?.close(true);
        setImmediate(() => this.exitForPublisherRecovery());
    }

    private exitForPublisherRecovery(): void { process.exit(1); }

    private failSourceRecovery(reason: string) {
        process.send?.({event: 'reader_source_incomplete', error: reason, assignment_id: this.assignmentId});
        this.failPublisherRecovery(reason, {predicate: 'source_recovery_required'});
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
