import { estypes } from "@elastic/elasticsearch";
import { HyperionConfig, NodeAttributeRequirement, TieredIndexAllocationSettings } from "../../interfaces/hyperionConfig.js";
import { ConnectionManager } from "../connections/manager.class.js";
import { hLog } from "../helpers/common_functions.js";
import { HyperionMaster } from "./master.js";
import { delay } from "lodash";

interface IndexData {
    index: string;
    partNumber: number;
    startBlock: number;
    finalBlock: number;
    size: string;
    keep: boolean;
    blockCount?: number;
}

export class HyperionLifecycleManager {

    master: HyperionMaster;
    conf: HyperionConfig;
    manager: ConnectionManager;

    allocation?: TieredIndexAllocationSettings
    allocationEnabled = false;
    nodeAttribute?: NodeAttributeRequirement;
    maxRetainedBlocks?: number;
    autoPrune = false;
    totalDeletedBytes = 0;

    private lastPruningCheckBlockNum = 0;

    constructor(master: HyperionMaster) {
        this.master = master;
        this.conf = this.master.conf;
        this.manager = this.master.manager;
        this.allocation = this.conf.settings.tiered_index_allocation;

        if (this.conf.settings.max_retained_blocks) {
            this.maxRetainedBlocks = this.conf.settings.max_retained_blocks;

            // Negative values are not allowed
            if (this.maxRetainedBlocks < 0) {
                this.maxRetainedBlocks = 0;
            }

            const indexPartitionSize = this.conf.settings.index_partition_size;

            // Must be a multiple of index partition size, round up if necessary
            if (this.maxRetainedBlocks % indexPartitionSize !== 0) {
                hLog(`max_retained_blocks (${this.maxRetainedBlocks}) is not a multiple of index partition size (${indexPartitionSize}).`);
                hLog(`Adjusting max_retained_blocks to be a multiple of index partition size.`);
                this.maxRetainedBlocks += (indexPartitionSize - (this.maxRetainedBlocks % indexPartitionSize));
            }
        }

        if (!this.maxRetainedBlocks || this.maxRetainedBlocks === 0) {
            hLog(`max_retained_blocks is not configured. Auto pruning will not be performed.`);
        } else {
            hLog(`max_retained_blocks is set to ${this.maxRetainedBlocks}. Auto pruning will be performed.`);
            this.autoPrune = true;
        }

        if (!this.allocation) {
            hLog(`Tiered index allocation is not configured`);
        }

        if (this.allocation && this.allocation.enabled === true) {
            const {
                require_node_attributes,
                include_node_attributes,
                exclude_node_attributes
            } = this.allocation;

            if (
                (require_node_attributes && Object.keys(require_node_attributes).length > 0) ||
                (include_node_attributes && Object.keys(include_node_attributes).length > 0) ||
                (exclude_node_attributes && Object.keys(exclude_node_attributes).length > 0)
            ) {
                this.allocationEnabled = true;
                hLog(`Tiered index allocation is enabled!`);
            } else {
                hLog(`Tiered index allocation is enabled but no node attribute requirements are specified`);
            }
        }
    }

    async notifyConsumedBlock(blockNum: number) {
        if (!this.autoPrune) {
            return;
        }

        const partitionSize = this.conf.settings.index_partition_size;
        if (partitionSize <= 0) {
            return; // Pruning is based on partitions, so this is required.
        }

        if (this.lastPruningCheckBlockNum === 0) {
            // First block seen, initialize and return.
            this.lastPruningCheckBlockNum = blockNum;
            return;
        }

        // Calculate partitions based on 1-based block numbers
        const oldPartition = Math.floor((this.lastPruningCheckBlockNum - 1) / partitionSize);
        const newPartition = Math.floor((blockNum - 1) / partitionSize);

        if (newPartition > oldPartition) {
            hLog(`New index partition boundary crossed at block ${blockNum}. Triggering pruning check in 5 seconds...`);
            setTimeout(() => {
                this.checkPruning().catch((err) => {
                    hLog(`Error during pruning check: ${err.message}`);
                });
            }, 5000);
        }

        if (blockNum > this.lastPruningCheckBlockNum) {
            this.lastPruningCheckBlockNum = blockNum;
        }
    }

    startAllocationMonitoring() {
        if (!this.allocationEnabled || !this.allocation) {
            return;
        }

        if (this.allocation.max_age_days) {
            hLog(`Max Age: ${this.allocation.max_age_days} days`);
        }

        if (this.allocation.max_age_blocks) {
            hLog(`Max Age: ${this.allocation.max_age_blocks} blocks`);
        }
    }

    async startAutoPruning() {
        if (!this.autoPrune || !this.maxRetainedBlocks) {
            return;
        }
        hLog(`Auto pruning started with max retained blocks: ${this.maxRetainedBlocks}`);
        await this.checkPruning();
    }

    async checkPruning() {
        if (!this.autoPrune || !this.maxRetainedBlocks) {
            return;
        }
        this.totalDeletedBytes = 0;

        await this.pruneIndices("action");
        await this.pruneIndices("delta");

        await this.pruneBlocks();

        await this.checkTieredAllocation();

        if (this.totalDeletedBytes > 0) {
            const gbSaved = (this.totalDeletedBytes / (1024 * 1024 * 1024)).toFixed(2);
            hLog(`Total space saved by pruning: ${gbSaved} GB`);
        }

        hLog(`Auto pruning completed.`);
    }

    private attributesToObject(attributes: NodeAttributeRequirement[]): { [key: string]: string } {
        const obj: { [key: string]: string } = {};
        for (const attr of attributes) {
            obj[attr.key] = attr.value;
        }
        return obj;
    }

    async checkTieredAllocation() {

        if (!this.allocationEnabled || !this.allocation) {
            return;
        }

        hLog('Checking for tiered index allocation...');

        await this.applyTieredAllocationForType('action');
        await this.applyTieredAllocationForType('delta');

        hLog('Tiered index allocation check completed.');
    }

    private async applyTieredAllocationForType(indexType: string) {

        if (!this.allocationEnabled || !this.allocation) {
            return;
        }

        const esClient = this.manager.elasticsearchClient;
        const maxAgeDays = this.allocation.max_age_days;
        const maxAgeBlocks = this.allocation.max_age_blocks;

        if (!maxAgeDays && !maxAgeBlocks) {
            return;
        }

        // Get indices with their creation date
        const indices = await esClient.cat.indices({
            format: 'json',
            index: `${this.master.chain}-${indexType}-${this.conf.settings.index_version}-*`,
            h: 'index,creation.date' // creation.date is in epoch millis
        });

        if (!indices || indices.length === 0) {
            return;
        }

        let headBlockNum = 0;
        if (maxAgeBlocks) {
            try {
                const chainInfo = await this.master.rpc.v1.chain.get_info();
                if (chainInfo && chainInfo.head_block_num) {
                    headBlockNum = chainInfo.head_block_num.toNumber();
                } else {
                    hLog('Could not get head block number for tiered allocation check.');
                }
            } catch (e: any) {
                hLog(`Error getting chain info for tiered allocation: ${e.message}`);
            }
        }

        const settingsToApply: any = {};
        const logObject: any = {};

        if (this.allocation.require_node_attributes && Object.keys(this.allocation.require_node_attributes).length > 0) {
            settingsToApply['index.routing.allocation.require'] = this.allocation.require_node_attributes;
            logObject.require = settingsToApply['index.routing.allocation.require'];
        }
        if (this.allocation.include_node_attributes && Object.keys(this.allocation.include_node_attributes).length > 0) {
            settingsToApply['index.routing.allocation.include'] = this.allocation.include_node_attributes;
            logObject.include = settingsToApply['index.routing.allocation.include'];
        }
        if (this.allocation.exclude_node_attributes && Object.keys(this.allocation.exclude_node_attributes).length > 0) {
            settingsToApply['index.routing.allocation.exclude'] = this.allocation.exclude_node_attributes;
            logObject.exclude = settingsToApply['index.routing.allocation.exclude'];
        }

        if (Object.keys(settingsToApply).length === 0) {
            hLog('No allocation rules to apply.');
            return;
        }

        // Pretty print the settings to apply
        hLog(`Applying tiered allocation settings: ${JSON.stringify(logObject, null, 2)}`);

        const now = Date.now();

        for (const indexInfo of indices) {
            if (!indexInfo.index) {
                continue;
            }

            let shouldBeMoved = false;
            let reason = '';

            // Check by age in days
            if (maxAgeDays && indexInfo['creation.date']) {
                const creationDate = Number(indexInfo['creation.date']);
                const ageInMillis = now - creationDate;
                const ageInDays = ageInMillis / (1000 * 60 * 60 * 24);
                if (ageInDays > maxAgeDays) {
                    shouldBeMoved = true;
                    reason = `age in days (${ageInDays.toFixed(2)}) is greater than max_age_days (${maxAgeDays})`;
                }
            }

            // Check by age in blocks
            if (!shouldBeMoved && maxAgeBlocks && headBlockNum > 0) {
                const parts = indexInfo.index.split('-');
                const suffix = parts[parts.length - 1];
                const partitionNumber = parseInt(suffix, 10);

                if (!isNaN(partitionNumber)) {
                    const indexPartitionSize = this.conf.settings.index_partition_size;
                    const finalBlockOfIndex = partitionNumber * indexPartitionSize;

                    if ((headBlockNum - finalBlockOfIndex) > maxAgeBlocks) {
                        shouldBeMoved = true;
                        reason = `block age (${headBlockNum - finalBlockOfIndex}) is greater than max_age_blocks (${maxAgeBlocks})`;
                    }
                }
            }

            if (shouldBeMoved) {
                hLog(`Index ${indexInfo.index} is eligible for tiered allocation. Reason: ${reason}.`);
                try {
                    hLog(`Applying allocation rules to ${indexInfo.index}: ${JSON.stringify(logObject)}`);
                    await esClient.indices.putSettings({
                        index: indexInfo.index,
                        body: settingsToApply
                    });
                    hLog(`Successfully applied allocation rules to ${indexInfo.index}.`);
                } catch (error: any) {
                    hLog(`Error applying allocation rules to ${indexInfo.index}: ${error.message}`);
                }
            }
        }
    }



    async pruneBlocks() {

        if (!this.autoPrune || !this.maxRetainedBlocks) {
            hLog(`Auto pruning is not enabled or max retained blocks is not set.`);
            return;
        }

        const esClient = this.manager.elasticsearchClient;
        const blockIndices = await esClient.cat.indices({
            format: 'json',
            bytes: 'b',
            index: `${this.master.chain}-block-${this.conf.settings.index_version}*`
        });

        // console.dir(blockIndices, { depth: Infinity });

        if (blockIndices.length === 1) {

            const indexName = blockIndices[0].index;
            if (!indexName) {
                hLog(`No block index found to prune.`);
                return;
            }

            hLog(`Found block index: ${indexName}`);

            // Get the current head block number
            const chainInfo = await this.master.rpc.v1.chain.get_info();

            if (!chainInfo || !chainInfo.head_block_num) {
                hLog(`Failed to get the last irreversible block number.`);
                return;
            } else {
                hLog(`Current head block number: ${chainInfo.head_block_num}`);
            }

            // Block index is not partitioned, pruning must use delete_by_query
            const finalBlockToKeep = chainInfo.head_block_num.toNumber() - this.maxRetainedBlocks;

            if (finalBlockToKeep < 0) {
                hLog(`Final block to keep (${finalBlockToKeep}) is less than 0. No blocks will be pruned.`);
                return;
            } else {
                hLog(`Pruning block index ${indexName} to keep blocks from ${finalBlockToKeep} onwards...`);
            }

            // First lets use a search to simulate the delete_by_query
            const response = await esClient.search({
                index: indexName,
                size: 1,
                track_total_hits: true,
                sort: [{ block_num: { order: 'desc' } }],
                _source: false,
                query: { bool: { must: [{ range: { block_num: { lte: finalBlockToKeep } } }] } }
            });

            // console.dir(response, { depth: Infinity });

            const totalHits = response.hits.total as estypes.SearchTotalHits;
            if (totalHits && totalHits.value > 0) {
                hLog(`Found ${totalHits.value} blocks to prune from index ${blockIndices[0].index}.`);
                // Perform delete_by_query
                const deleteResponse = await esClient.deleteByQuery({
                    index: indexName,
                    query: { bool: { must: [{ range: { block_num: { lte: finalBlockToKeep } } }] } },
                    wait_for_completion: false
                });
                hLog(`Delete by query completed. Deleted ${deleteResponse.deleted} blocks.`);
                hLog(`Task ID: ${deleteResponse.task}`);
                if (deleteResponse.task && typeof deleteResponse.task === 'string') {
                    await this.startMonitoringDeleteTask(deleteResponse.task);
                }
            } else {
                hLog(`No blocks found to prune in index ${blockIndices[0].index}.`);
            }

        } else if (blockIndices.length > 1) {
            // Partitioned block index, we can prune by index
            hLog(`Multiple block indices found. Pruning by index...`);
            await this.pruneIndices('block');
        }
    }

    async startMonitoringDeleteTask(task: string) {
        if (!task) {
            hLog(`No task ID provided for monitoring.`);
            return;
        }

        const esClient = this.manager.elasticsearchClient;

        const checkTaskStatus = async () => {
            const taskInfo = await esClient.tasks.get({
                task_id: task
            });
            if (taskInfo.completed) {
                hLog(`Delete task ${task} completed.`);
            } else {
                hLog(`Delete task ${task} is still running...`);
                setTimeout(checkTaskStatus, 5000);
            }
        };

        checkTaskStatus();
    }

    async pruneIndices(indexType: string) {

        if (!this.autoPrune || !this.maxRetainedBlocks) {
            hLog(`Auto pruning is not enabled or max retained blocks is not set.`);
            return;
        }

        const esClient = this.manager.elasticsearchClient;

        // Get the list of indices on elasticsearch
        const actionIndices = await esClient.cat.indices({
            format: 'json',
            bytes: 'b',
            index: `${this.master.chain}-${indexType}-${this.conf.settings.index_version}-*`
        });

        const indexPartitionSize = this.conf.settings.index_partition_size;

        const indicesToPrune: IndexData[] = [];

        for (const index of actionIndices) {
            if (index.index) {
                const parts = index.index.split('-');
                const suffix = parts[parts.length - 1];
                const partitionNumber = parseInt(suffix, 10);
                // Calculate block range for this index
                const blockRange = partitionNumber * indexPartitionSize;
                const finalBlock = blockRange;
                const startBlock = blockRange - indexPartitionSize + 1;
                const size = index["dataset.size"];
                indicesToPrune.push({
                    index: index.index,
                    partNumber: partitionNumber,
                    startBlock: startBlock,
                    finalBlock: finalBlock,
                    size: size ?? '0',
                    keep: true,
                    blockCount: finalBlock - startBlock + 1
                });
            }
        }

        // Sort indices by partition number
        indicesToPrune.sort((a, b) => a.partNumber - b.partNumber);

        // Check the last block for the last index
        if (indicesToPrune.length > 0) {
            const lastIndex = indicesToPrune.at(-1);

            if (!lastIndex) {
                hLog(`No action indices found to prune.`);
                return;
            }

            const response = await esClient.search({
                index: lastIndex.index,
                size: 1,
                sort: [{ block_num: { order: 'desc' } }],
                _source: false,
                query: { match_all: {} }
            });

            // console.dir(response, { depth: Infinity });

            if (response.hits.hits.length > 0) {
                const hit = response.hits.hits[0];
                if (hit.sort && hit.sort.length > 0) {
                    const lastBlock = hit.sort[0];
                    if (lastBlock && typeof lastBlock === 'number') {
                        if (lastBlock < lastIndex.finalBlock && lastBlock >= lastIndex.startBlock) {
                            // Update the final block to the last block found
                            lastIndex.finalBlock = lastBlock;
                            lastIndex.blockCount = lastIndex.finalBlock - lastIndex.startBlock + 1;
                        }
                    }
                }
            }
        }

        // Reverse loop to find indices to prune, use the maxRetainedBlocks
        let totalBlocks = 0;
        let totalPrunedBytes = 0;
        for (let i = indicesToPrune.length - 1; i >= 0; i--) {
            const indexData = indicesToPrune[i];
            if (indexData.keep) {
                totalBlocks += indexData.finalBlock - indexData.startBlock + 1;
                if (totalBlocks > (this.maxRetainedBlocks + indexPartitionSize)) {
                    // Mark this index for pruning
                    indexData.keep = false;
                    totalPrunedBytes += parseInt(indexData.size, 10);
                }
            }
        }

        hLog(`--- Index Pruning Report ( ${indexType.toUpperCase()} ) ---`);
        hLog(`Total indices found: ${indicesToPrune.length}`);
        hLog(`Total blocks retained: ${totalBlocks}`);

        hLog(`Indices to be pruned:`);
        for (const indexData of indicesToPrune) {
            if (!indexData.keep) {
                hLog(`- ${indexData.index} (From:${indexData.startBlock} | To:${indexData.finalBlock} Blocks: ${indexData.blockCount})`);
            }
        }

        if (indicesToPrune.length === 0) {
            hLog(`No indices to prune.`);
        } else {
            hLog(`Total indices to be pruned: ${indicesToPrune.filter(i => !i.keep).length}`);
        }

        hLog(`Indices to be kept:`);
        for (const indexData of indicesToPrune) {
            if (indexData.keep) {
                hLog(`- ${indexData.index} (From:${indexData.startBlock} | To:${indexData.finalBlock} Blocks: ${indexData.blockCount})`);
            }
        }

        hLog(`--- End of Report ---`);

        for (const indexData of indicesToPrune) {
            if (indexData.keep === false) {
                try {
                    hLog(`Deleting index: ${indexData.index}...`);
                    const result = await esClient.indices.delete({ index: indexData.index });
                    if (result.acknowledged) {
                        this.totalDeletedBytes += indexData.size ? parseInt(indexData.size, 10) : 0;
                        hLog(`Index ${indexData.index} deleted successfully.`);
                    }
                } catch (err: any) {
                    hLog(`Error deleting index ${indexData.index}: ${err.message}`);
                }
            }
        }
    }

    start() {
        hLog(`Lifecycle Manager started`);

        if (this.conf.settings.tiered_index_allocation?.enabled) {
            this.startAllocationMonitoring();
        }

        if (this.autoPrune) {
            this.startAutoPruning().catch((err) => {
                hLog(`Error starting auto pruning: ${err.message}`)
            });
        }
    }
}