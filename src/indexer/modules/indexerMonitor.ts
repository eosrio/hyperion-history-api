import cluster from "cluster";
import { HyperionConfig } from "../../interfaces/hyperionConfig.js";
import { ConnectionManager } from "../connections/manager.class.js";
import { hLog } from "../helpers/common_functions.js";
import { HyperionMaster } from "./master.js";

export class HyperionIndexerMonitor {

    master: HyperionMaster;
    conf: HyperionConfig;
    manager: ConnectionManager;

    consumedBlocks = 0;
    deserializedActions = 0;
    indexedObjects = 0;
    deserializedDeltas = 0;
    liveConsumedBlocks = 0;
    livePushedBlocks = 0;
    pushedBlocks = 0;
    total_read = 0;
    total_blocks = 0;
    total_actions = 0;
    total_deltas = 0;
    total_abis = 0;
    total_range = 0;
    auto_stop = 0;
    range_completed = false;

    private consume_rates: number[] = [];
    private idle_count = 0;
    private avg_consume_rate: number = 0;

    private readonly log_interval = 5000;
    private readonly tScale = this.log_interval / 1000;

    intervals = [
        { label: 'year', seconds: 60 * 60 * 24 * 365 },
        { label: 'month', seconds: 60 * 60 * 24 * 30 },
        { label: 'day', seconds: 60 * 60 * 24 },
        { label: 'hour', seconds: 60 * 60 },
        { label: 'minute', seconds: 60 }
    ];

    constructor(master: HyperionMaster) {
        this.master = master;
        this.conf = this.master.conf;
        this.manager = this.master.manager;
    }

    private getRelativeTime(seconds: number): string {
        // console.log(`Calculating relative time for ${seconds} seconds`);
        for (const interval of this.intervals) {
            const count = Math.floor(seconds / interval.seconds);
            if (count >= 1) {
                const plural = count !== 1 ? 's' : '';
                return `in ${count} ${interval.label}${plural}`;
            }
        }
        return 'in a few seconds';
    }

    startIndexMonitoring() {
        let reference_time = Date.now();
        setInterval(() => {
            this.indexerMonitorCycle(reference_time);
        }, this.log_interval);
    }

    private logMetrics(_workers: number) {
        const log_msg: string[] = [];

        // print current head for live reading
        if (this.master.lastProducedBlockNum > 0 && this.master.lastIrreversibleBlock > 0) {
            log_msg.push(`H:${this.master.lastProducedBlockNum} L:${this.master.lastIrreversibleBlock}`);
        }

        log_msg.push(`W:${_workers}`);

        const _r = (this.pushedBlocks + this.livePushedBlocks) / this.tScale;
        log_msg.push(`R:${_r}`);
        // this.metrics.readingRate?.set(_r);

        const _c = (this.liveConsumedBlocks + this.consumedBlocks) / this.tScale;
        log_msg.push(`C:${_c}`);
        // this.metrics.consumeRate?.set(_c);

        const _a = this.deserializedActions / this.tScale;
        log_msg.push(`A:${_a}`);
        // this.metrics.actionDSRate?.set(_a);

        const _dds = this.deserializedDeltas / this.tScale;
        log_msg.push(`D:${_dds}`);
        // this.metrics.deltaDSRate?.set(_dds);

        const _ir = this.indexedObjects / this.tScale;
        log_msg.push(`I:${_ir}`);
        // this.metrics.indexingRate?.set(_ir);

        if (this.total_blocks < this.total_range && !this.conf.indexer.live_only_mode) {
            let time_string = 'waiting for indexer';
            if (this.avg_consume_rate > 0) {
                const remaining = this.total_range - this.total_blocks;
                const estimated_time = Math.round(remaining / this.avg_consume_rate);
                time_string = this.getRelativeTime(estimated_time);
            }
            const pct_parsed = ((this.total_blocks / this.total_range) * 100).toFixed(1);
            const pct_read = ((this.total_read / this.total_range) * 100).toFixed(1);
            log_msg.push(`${this.total_blocks}/${this.total_read}/${this.total_range}`);
            log_msg.push(`syncs ${time_string} (${pct_parsed}% ${pct_read}%)`);
            // this.metrics.syncEta.set(time_string);
        }

        // publish last processed block to pm2
        // this.metrics.lastProcessedBlockNum.set(this.lastProcessedBlockNum);

        // publish log to hub
        if (this.conf.hub && this.conf.hub.hub_url && this.master.hub) {
            this.master.hub?.emit('hyp_ev', {
                e: 'rates',
                d: { r: _r, c: _c, a: _a }
            });
        }

        // print monitoring log
        if (this.conf.settings.rate_monitoring && !this.master.mode_transition) {
            hLog(log_msg.join(' | '));
        }
    }

    resetMonitoringCounters() {
        this.pushedBlocks = 0;
        this.livePushedBlocks = 0;
        this.consumedBlocks = 0;
        this.liveConsumedBlocks = 0;
        this.deserializedActions = 0;
        this.deserializedDeltas = 0;
        this.indexedObjects = 0;
    }

    private indexerMonitorCycle(reference_time: number): void {
        let _workers = 0;

        if (cluster.workers) {
            _workers = Object.keys(cluster.workers).length;
        }

        this.updateIndexingRates();

        this.logMetrics(_workers);

        if (this.liveConsumedBlocks > 0 && this.consumedBlocks === 0 && this.conf.indexer.abi_scan_mode) {
            hLog('Warning: Live reading on ABI SCAN mode');
        }

        if (this.liveConsumedBlocks + this.indexedObjects + this.deserializedActions + this.consumedBlocks === 0 && !this.master.mode_transition) {
            // Report completed range (parallel reading)
            if (this.total_blocks === this.total_range && !this.range_completed) {
                const ttime = (Date.now() - reference_time) / 1000;
                hLog(`\n
        -------- BLOCK RANGE COMPLETED -------------
        | Range: ${this.master.starting_block} >> ${this.master.head}
        | Total time: ${ttime} seconds
        | Blocks: ${this.total_range}
        | Actions: ${this.total_actions}
        | Deltas: ${this.total_deltas}
        | ABIs: ${this.total_abis}
        --------------------------------------------\n`);
                this.range_completed = true;
                if (this.conf.indexer.abi_scan_mode) {
                    // TODO: Confirm this is working as expected
                    if (this.conf.settings.auto_mode_switch) {
                        this.master.mode_transition = true;
                        hLog('Auto switching to full indexing mode in 10 seconds...');
                        setTimeout(() => {
                            reference_time = Date.now();
                            this.master.startFullIndexing().catch(console.error);
                        });
                    }
                }
            }

            if (!this.master.mode_transition) {
                // Allow 10s threshold before shutting down the process
                this.master.shutdownTimer = setTimeout(() => {
                    this.master.allowShutdown = true;
                }, 10000);

                // Auto-Stop
                if (this.pushedBlocks === 0) {
                    this.idle_count++;
                    if (this.auto_stop > 0) {
                        if (this.tScale * this.idle_count >= this.auto_stop) {
                            hLog('Reached limit for no blocks processed, stopping now...');
                            process.exit(1);
                        } else {
                            const idleMsg = `No blocks processed! Indexer will stop in ${this.auto_stop - this.tScale * this.idle_count} seconds!`;
                            if (this.idle_count === 1) {
                                this.master.emitAlert('IndexerIdle', idleMsg);
                            }
                            hLog(idleMsg);
                        }
                    } else {
                        if (!this.master.shutdownStarted) {
                            const readers = this.master.workerMap.filter((value) => {
                                return value.worker_role === 'reader' || value.worker_role === 'continuous_reader';
                            });
                            if (readers.length === 0) {
                                hLog(`No more active workers, stopping now...`);
                                process.exit();
                            }
                            const idleMsg = 'No blocks are being processed, please check your state-history node!';
                            if (this.idle_count === 2) {
                                this.master.emitAlert('IndexerIdle', idleMsg);
                            }

                            hLog(idleMsg);

                            // attempt to move readers to another server if there are fail-over servers defined
                            if (this.idle_count === 3 && this.master.validatedShipServers.length > 1) {
                                readers.forEach((w) => {
                                    w.wref?.send({ event: 'next_server' });
                                });
                            }
                        }
                    }
                }
            }
        } else {
            if (this.idle_count > 1) {
                this.master.emitAlert('IndexerResumed', '✅ Data processing resumed!');
                hLog('Processing resumed!');
            }
            this.idle_count = 0;
            if (this.master.shutdownTimer) {
                clearTimeout(this.master.shutdownTimer);
                this.master.shutdownTimer = undefined;
            }
        }

        // reset counters
        this.resetMonitoringCounters();

        if (_workers === 0 && !this.master.mode_transition) {
            hLog('FATAL ERROR - All Workers have stopped!');
            process.exit(1);
        }
    }

    private updateIndexingRates() {
        this.total_read += this.pushedBlocks;
        this.total_blocks += this.consumedBlocks;
        this.total_actions += this.deserializedActions;
        this.total_deltas += this.deserializedDeltas;
        const consume_rate = this.consumedBlocks / this.tScale;
        this.consume_rates.push(consume_rate);
        if (this.consume_rates.length > 20) {
            this.consume_rates.splice(0, 1);
        }
        this.avg_consume_rate = 0;
        if (this.consume_rates.length > 0) {
            for (const r of this.consume_rates) {
                this.avg_consume_rate += r;
            }
            this.avg_consume_rate = this.avg_consume_rate / this.consume_rates.length;
        } else {
            this.avg_consume_rate = consume_rate;
        }
    }
}