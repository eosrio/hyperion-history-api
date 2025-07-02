import { IndexerController } from "./controller-client/controller.client.js";

// --- Usage/Memory/Heap commands ---
export async function printUsageMap(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    try {
        const response = await indexerController.getUsageMap();
        console.log('\n📊 Contract Usage Statistics for Chain:', chain.toUpperCase());
        console.log('='.repeat(85));

        if (!response?.data || Object.keys(response.data).length === 0) {
            console.log('❌ No contract usage data available.');
            console.log('   This might indicate that:');
            console.log('   • The indexer is not actively processing actions');
            console.log('   • No contracts have been active recently');
            console.log('   • The monitoring system is not yet initialized');
            return;
        }

        const usageMap = response.data;
        const timing = response.timing;
        const loadDistribution = response.loadDistributionPeriod;

        // Calculate total hits across all contracts
        let totalHits = 0;
        for (const contract in usageMap) {
            totalHits += usageMap[contract][0];
        }

        // Sort contracts by usage (most used first)
        const sortedContracts = Object.entries(usageMap as Record<string, [number, number, number[]]>)
            .sort(([, a], [, b]) => (b[0] as number) - (a[0] as number));

        // Enhanced summary section with timing information
        console.log('📈 SUMMARY');
        console.log(`   Total Action Processing Load: ${totalHits.toLocaleString()} actions`);
        console.log(`   Active Smart Contracts: ${sortedContracts.length}`);

        if (timing) {
            const timeSinceUpdate = timing.timeSinceLastUpdate ?
                `${(timing.timeSinceLastUpdate / 1000).toFixed(1)}s ago` : 'Never';
            const nextUpdate = timing.nextUpdateIn ?
                `in ${(timing.nextUpdateIn / 1000).toFixed(1)}s` : 'Unknown';
            console.log(`   Last Monitoring Update: ${timeSinceUpdate}`);
            console.log(`   Next Update: ${nextUpdate}`);
        }

        if (loadDistribution) {
            console.log('');
            console.log('⚡ LOAD DISTRIBUTION PERIOD');
            console.log(`   Monitoring Interval: ${loadDistribution.intervalMs / 1000}s`);
            console.log(`   Last Cycle Duration: ${loadDistribution.lastCycleDurationMs?.toFixed(2) || 'N/A'}ms`);
            console.log(`   Average Cycle Duration: ${loadDistribution.averageCycleDurationMs?.toFixed(2) || 'N/A'}ms`);
            console.log(`   Total Cycles Completed: ${loadDistribution.totalCycles?.toLocaleString() || 'N/A'}`);

            if (loadDistribution.performanceRatio) {
                console.log(`   Performance Impact: ${loadDistribution.performanceRatio} of interval time`);
            }

            const healthStatus = loadDistribution.isHealthy ? '✅ Healthy' : '⚠️  High Load';
            console.log(`   System Health: ${healthStatus}`);

            if (loadDistribution.uptime) {
                const uptimeHours = (loadDistribution.uptime / (1000 * 60 * 60)).toFixed(1);
                console.log(`   Monitoring Uptime: ${uptimeHours}h`);
            }
        }

        console.log('');

        // Header with better spacing
        console.log('🏢 CONTRACT ACTIVITY BREAKDOWN');
        console.log('Contract Name'.padEnd(20) +
            'Action Count'.padStart(15) +
            'Load %'.padStart(10) +
            'Workers'.padStart(12) +
            'Load Level'.padStart(15));
        console.log('-'.repeat(85));

        // Print each contract's usage with enhanced formatting
        for (const [contractName, [hits, percentage, workers]] of sortedContracts) {
            const hitsFormatted = hits.toLocaleString().padStart(15);
            const percentageFormatted = (percentage * 100).toFixed(2) + '%';
            const workersFormatted = Array.isArray(workers) ?
                (workers.length > 0 ? `[${workers.join(',')}]` : '[none]') : '[none]';

            // Determine load level
            let loadLevel = '';
            let loadEmoji = '';
            const loadPct = percentage * 100;
            if (loadPct >= 50) {
                loadLevel = 'VERY HIGH';
                loadEmoji = '🔥';
            } else if (loadPct >= 20) {
                loadLevel = 'HIGH';
                loadEmoji = '⚡';
            } else if (loadPct >= 5) {
                loadLevel = 'MEDIUM';
                loadEmoji = '📊';
            } else if (loadPct >= 1) {
                loadLevel = 'LOW';
                loadEmoji = '📉';
            } else {
                loadLevel = 'MINIMAL';
                loadEmoji = '💤';
            }

            console.log(contractName.padEnd(20) +
                hitsFormatted +
                percentageFormatted.padStart(10) +
                workersFormatted.padStart(12) +
                `${loadEmoji} ${loadLevel}`.padStart(15));
        }

        console.log('='.repeat(85));

        // Enhanced legend with more context
        console.log('\n� DETAILED INFORMATION:');
        console.log('');
        console.log('📋 Column Descriptions:');
        console.log('   • Contract Name: Smart contract account name (e.g., eosio, eosio.token)');
        console.log('   • Action Count: Total actions processed from this contract since last reset');
        console.log('   • Load %: Percentage of total indexer processing load consumed by this contract');
        console.log('   • Workers: Deserializer worker pool IDs currently assigned to handle this contract');
        console.log('   • Load Level: Visual indicator of processing intensity');
        console.log('');
        console.log('⚡ Load Distribution Period:');
        console.log('   • The system automatically rebalances workload every 5 seconds');
        console.log('   • High-usage contracts get distributed across multiple workers');
        console.log('   • Performance metrics help monitor system efficiency');
        console.log('   • Healthy systems use <10% of the interval time for load balancing');
        console.log('');
        console.log('⚙️  Worker Assignment Strategy:');
        console.log('   • High-usage contracts are distributed across multiple workers');
        console.log('   • Worker assignments are dynamically balanced based on processing load');
        console.log('   • [none] indicates no dedicated workers currently assigned');
        console.log('');
        console.log('📊 Load Level Guide:');
        console.log('   🔥 VERY HIGH (≥50%): Dominant contract consuming most resources');
        console.log('   ⚡ HIGH (20-49%): Major contract with significant load');
        console.log('   📊 MEDIUM (5-19%): Moderate usage contract');
        console.log('   📉 LOW (1-4%): Low activity contract');
        console.log('   💤 MINIMAL (<1%): Very low or sporadic activity');

    } catch (error: any) {
        console.error('❌ Error fetching usage map:', error.message);
        console.error('   Please check:');
        console.error('   • Indexer is running and accessible');
        console.error('   • Network connectivity to the indexer');
        console.error('   • Correct chain name and host configuration');
    } finally {
        indexerController.close();
    }
}

export async function printMemoryUsage(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    try {
        const memUsage = await indexerController.getMemoryUsage();
        console.log('\n🧠 Memory Usage Report for Chain:', chain.toUpperCase());
        console.log('='.repeat(70));

        if (!memUsage || Object.keys(memUsage).length === 0) {
            console.log('❌ No memory usage data available.');
            console.log('   This might indicate that:');
            console.log('   • The indexer workers are not running');
            console.log('   • Memory monitoring is not enabled');
            console.log('   • The indexer is starting up');
            return;
        }

        // Parse and categorize workers
        const workerCategories: Record<string, Array<{ name: string, memory: string, memoryBytes: number }>> = {};
        let totalMemoryBytes = 0;

        for (const [workerName, memData] of Object.entries(memUsage)) {
            const memoryStr = (memData as any).resident;
            const memoryBytes = parseFloat(memoryStr.replace(' MB', '')) * 1024 * 1024;
            totalMemoryBytes += memoryBytes;

            // Extract worker type from name (e.g., 'continuous_reader:2' -> 'continuous_reader')
            const workerType = workerName.split(':')[0];

            if (!workerCategories[workerType]) {
                workerCategories[workerType] = [];
            }

            workerCategories[workerType].push({
                name: workerName,
                memory: memoryStr,
                memoryBytes: memoryBytes
            });
        }

        // Calculate total memory in MB and GB
        const totalMemoryMB = totalMemoryBytes / (1024 * 1024);
        const totalMemoryGB = totalMemoryMB / 1024;

        // Summary section
        console.log('📊 SUMMARY');
        console.log(`   Total Workers: ${Object.keys(memUsage).length}`);
        console.log(`   Total Memory Usage: ${totalMemoryMB.toFixed(2)} MB (${totalMemoryGB.toFixed(2)} GB)`);
        console.log(`   Worker Categories: ${Object.keys(workerCategories).length}`);
        console.log('');

        // Print each category
        console.log('🔧 WORKER MEMORY BREAKDOWN');
        console.log('Worker Name'.padEnd(25) + 'Memory Usage'.padStart(15) + 'Category'.padStart(20));
        console.log('-'.repeat(70));

        // Sort categories by total memory usage (highest first)
        const sortedCategories = Object.entries(workerCategories)
            .map(([type, workers]) => ({
                type,
                workers,
                totalMemory: workers.reduce((sum, w) => sum + w.memoryBytes, 0)
            }))
            .sort((a, b) => b.totalMemory - a.totalMemory);

        for (const { type, workers } of sortedCategories) {
            // Sort workers within category by memory usage (highest first)
            const sortedWorkers = workers.sort((a, b) => b.memoryBytes - a.memoryBytes);

            for (const worker of sortedWorkers) {
                // Determine memory level emoji
                const memoryMB = worker.memoryBytes / (1024 * 1024);
                let memoryEmoji = '';
                if (memoryMB >= 100) {
                    memoryEmoji = '[H]'; // High memory usage
                } else if (memoryMB >= 90) {
                    memoryEmoji = '[M]'; // Medium-high
                } else if (memoryMB >= 80) {
                    memoryEmoji = '[N]'; // Medium/Normal
                } else {
                    memoryEmoji = '[L]'; // Low/normal
                }

                const workerDisplay = `${memoryEmoji} ${worker.name}`.padEnd(25);
                const memoryDisplay = worker.memory.padStart(15);
                const categoryDisplay = type.toUpperCase().padStart(20);

                console.log(workerDisplay + memoryDisplay + categoryDisplay);
            }
        }

        console.log('='.repeat(70));

        // Category summary
        console.log('\n📈 MEMORY BY CATEGORY');
        for (const { type, workers, totalMemory } of sortedCategories) {
            const categoryMemoryMB = totalMemory / (1024 * 1024);
            const categoryPercentage = (totalMemory / totalMemoryBytes) * 100;

            console.log(`   ${type.toUpperCase().padEnd(20)}: ${categoryMemoryMB.toFixed(2)} MB (${categoryPercentage.toFixed(1)}%) - ${workers.length} worker(s)`);
        }

        // Legend and additional information
        console.log('\n🔍 DETAILED INFORMATION:');
        console.log('');
        console.log('📋 Worker Types:');
        console.log('   • CONTINUOUS_READER: Reads blocks from the blockchain');
        console.log('   • DESERIALIZER: Processes and deserializes blockchain data');
        console.log('   • INGESTOR: Ingests processed data into the database');
        console.log('   • ROUTER: Routes data between different components');
        console.log('   • DS_POOL_WORKER: Deserializer pool workers for parallel processing');
        console.log('');
        console.log('🧠 Memory Usage Indicators:');
        console.log('   [H] HIGH (≥100MB): Heavy memory usage - monitor closely');
        console.log('   [M] MEDIUM-HIGH (90-99MB): Elevated usage - normal under load');
        console.log('   [N] NORMAL (80-89MB): Moderate usage - typical operation');
        console.log('   [L] LOW (<80MB): Low usage - efficient operation');

    } catch (error: any) {
        console.error('❌ Error fetching memory usage:', error.message);
        console.error('   Please check:');
        console.error('   • Indexer is running and accessible');
        console.error('   • Network connectivity to the indexer');
        console.error('   • Correct chain name and host configuration');
    } finally {
        indexerController.close();
    }
}

export async function printHeapStats(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    try {
        const heapStats = await indexerController.getHeapStats();
        console.log('\n🧠 V8 Heap Statistics for Chain:', chain.toUpperCase());
        console.log('='.repeat(80));

        if (!heapStats || Object.keys(heapStats).length === 0) {
            console.log('❌ No heap statistics data available.');
            console.log('   This might indicate that:');
            console.log('   • The indexer workers are not running');
            console.log('   • Heap monitoring is not enabled');
            console.log('   • The indexer is starting up');
            return;
        }

        // Parse and categorize workers
        const workerCategories: Record<string, Array<{
            name: string,
            heapUsage: string,
            usedHeapMB: number,
            totalHeapMB: number,
            heapLimitMB: number,
            rawData: any
        }>> = {};

        let totalUsedHeapBytes = 0;
        let totalHeapLimitBytes = 0;

        for (const [workerName, heapData] of Object.entries(heapStats)) {
            const data = heapData as any;
            const usedHeapBytes = data.used_heap_size || 0;
            const totalHeapBytes = data.total_heap_size || 0;
            const heapLimitBytes = data.heap_size_limit || 0;

            totalUsedHeapBytes += usedHeapBytes;
            totalHeapLimitBytes += heapLimitBytes;

            // Extract worker type from name
            const workerType = workerName.split(':')[0];

            if (!workerCategories[workerType]) {
                workerCategories[workerType] = [];
            }

            workerCategories[workerType].push({
                name: workerName,
                heapUsage: data.heap_usage || '0%',
                usedHeapMB: usedHeapBytes / (1024 * 1024),
                totalHeapMB: totalHeapBytes / (1024 * 1024),
                heapLimitMB: heapLimitBytes / (1024 * 1024),
                rawData: data
            });
        }

        // Calculate totals
        const totalUsedHeapMB = totalUsedHeapBytes / (1024 * 1024);
        const totalHeapLimitMB = totalHeapLimitBytes / (1024 * 1024);
        const totalUsedHeapGB = totalUsedHeapMB / 1024;
        const totalHeapLimitGB = totalHeapLimitMB / 1024;
        const overallUsagePercent = (totalUsedHeapBytes / totalHeapLimitBytes) * 100;

        // Summary section
        console.log('📊 SUMMARY');
        console.log(`   Total Workers: ${Object.keys(heapStats).length}`);
        console.log(`   Total Used Heap: ${totalUsedHeapMB.toFixed(2)} MB (${totalUsedHeapGB.toFixed(2)} GB)`);
        console.log(`   Total Heap Limit: ${totalHeapLimitMB.toFixed(2)} MB (${totalHeapLimitGB.toFixed(2)} GB)`);
        console.log(`   Overall Heap Usage: ${overallUsagePercent.toFixed(2)}%`);
        console.log(`   Worker Categories: ${Object.keys(workerCategories).length}`);
        console.log('');

        // Print main heap statistics table
        console.log('🔧 WORKER HEAP BREAKDOWN');
        console.log('Worker Name'.padEnd(25) + 'Usage %'.padStart(10) + 'Used Heap'.padStart(15) + 'Total Heap'.padStart(15) + 'Category'.padStart(20));
        console.log('-'.repeat(80));

        // Sort categories by total heap usage (highest first)
        const sortedCategories = Object.entries(workerCategories)
            .map(([type, workers]) => ({
                type,
                workers,
                totalUsedHeap: workers.reduce((sum, w) => sum + w.usedHeapMB, 0)
            }))
            .sort((a, b) => b.totalUsedHeap - a.totalUsedHeap);

        for (const { type, workers } of sortedCategories) {
            // Sort workers within category by heap usage (highest first)
            const sortedWorkers = workers.sort((a, b) => b.usedHeapMB - a.usedHeapMB);

            for (const worker of sortedWorkers) {
                // Determine heap usage level indicator
                const usagePercent = parseFloat(worker.heapUsage.replace('%', ''));
                let heapIndicator = '';
                if (usagePercent >= 80) {
                    heapIndicator = '[H]'; // High heap usage
                } else if (usagePercent >= 60) {
                    heapIndicator = '[M]'; // Medium-high
                } else if (usagePercent >= 40) {
                    heapIndicator = '[N]'; // Normal
                } else {
                    heapIndicator = '[L]'; // Low
                }

                const workerDisplay = `${heapIndicator} ${worker.name}`.padEnd(25);
                const usageDisplay = worker.heapUsage.padStart(10);
                const usedHeapDisplay = `${worker.usedHeapMB.toFixed(1)} MB`.padStart(15);
                const totalHeapDisplay = `${worker.totalHeapMB.toFixed(1)} MB`.padStart(15);
                const categoryDisplay = type.toUpperCase().padStart(20);

                console.log(workerDisplay + usageDisplay + usedHeapDisplay + totalHeapDisplay + categoryDisplay);
            }
        }

        console.log('='.repeat(80));

        // Category summary
        console.log('\n📈 HEAP USAGE BY CATEGORY');
        for (const { type, workers, totalUsedHeap } of sortedCategories) {
            const categoryPercentage = (totalUsedHeap / totalUsedHeapMB) * 100;
            const avgUsagePerWorker = totalUsedHeap / workers.length;

            console.log(`   ${type.toUpperCase().padEnd(20)}: ${totalUsedHeap.toFixed(2)} MB (${categoryPercentage.toFixed(1)}%) - ${workers.length} worker(s) - Avg: ${avgUsagePerWorker.toFixed(1)} MB/worker`);
        }

        // Additional heap statistics
        console.log('\n📋 DETAILED HEAP METRICS');
        console.log('Worker Name'.padEnd(25) + 'Heap Limit'.padStart(15) + 'Physical Size'.padStart(15) + 'External Mem'.padStart(15));
        console.log('-'.repeat(80));

        for (const { type, workers } of sortedCategories) {
            const sortedWorkers = workers.sort((a, b) => b.usedHeapMB - a.usedHeapMB);

            for (const worker of sortedWorkers) {
                const heapLimitDisplay = `${worker.heapLimitMB.toFixed(1)} MB`.padStart(15);
                const physicalSizeDisplay = `${((worker.rawData.total_physical_size || 0) / (1024 * 1024)).toFixed(1)} MB`.padStart(15);
                const externalMemDisplay = `${((worker.rawData.external_memory || 0) / (1024 * 1024)).toFixed(1)} MB`.padStart(15);

                console.log(worker.name.padEnd(25) + heapLimitDisplay + physicalSizeDisplay + externalMemDisplay);
            }
        }

        console.log('='.repeat(80));

        // Legend and additional information
        console.log('\n🔍 DETAILED INFORMATION:');
        console.log('');
        console.log('📋 Heap Usage Indicators:');
        console.log('   [H] HIGH (≥80%): High heap pressure - monitor for memory leaks');
        console.log('   [M] MEDIUM-HIGH (60-79%): Elevated usage - may need attention');
        console.log('   [N] NORMAL (40-59%): Moderate usage - typical operation');
        console.log('   [L] LOW (<40%): Low usage - efficient memory management');
        console.log('');
        console.log('📊 Metrics Explanation:');
        console.log('   • Usage %: Percentage of heap limit currently being used');
        console.log('   • Used Heap: Current memory allocated for JavaScript objects');
        console.log('   • Total Heap: Total size of the heap (includes free space)');
        console.log('   • Heap Limit: Maximum heap size allowed by V8');
        console.log('   • Physical Size: Actual memory used by the heap');
        console.log('   • External Mem: Memory used by C++ objects bound to JavaScript');
        console.log('');
        console.log('⚠️  Heap Management Tips:');
        console.log('   • Workers consistently above 80% may need heap limit increases');
        console.log('   • Monitor external memory for native module memory leaks');
        console.log('   • High physical size vs used heap indicates fragmentation');
        console.log('   • Consider garbage collection if heap usage is consistently high');

    } catch (error: any) {
        console.error('❌ Error fetching heap stats:', error.message);
        console.error('   Please check:');
        console.error('   • Indexer is running and accessible');
        console.error('   • Network connectivity to the indexer');
        console.error('   • Correct chain name and host configuration');
    } finally {
        indexerController.close();
    }
}