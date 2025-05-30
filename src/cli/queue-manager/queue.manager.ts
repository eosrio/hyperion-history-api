import { readConnectionConfig } from "../repair-cli/functions.js";
import { HyperionConnections } from "../../interfaces/hyperionConnections.js";

interface QueueInfo {
    name: string;
    messages: number;
    consumers: number;
    memory: number;
    state: string;
    node: string;
    arguments?: Record<string, any>;
    vhost: string;
    auto_delete: boolean;
    durable: boolean;
    exclusive: boolean;
    message_stats?: {
        publish_details?: {
            rate: number;
        };
        deliver_details?: {
            rate: number;
        };
        ack_details?: {
            rate: number;
        };
    };
}

interface QueueListOptions {
    showAll?: boolean;
    showEmpty?: boolean;
    sortBy?: 'name' | 'messages' | 'consumers';
    filterPattern?: string;
}

export class QueueManager {
    private connections: HyperionConnections;

    constructor() {
        this.connections = readConnectionConfig();
    }

    private getAuthHeaders(): HeadersInit {
        const credentials = Buffer.from(
            `${this.connections.amqp.user}:${this.connections.amqp.pass}`
        ).toString('base64');

        return {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json'
        };
    }

    private getApiUrl(): string {
        const protocol = this.connections.amqp.protocol || 'http';
        return `${protocol}://${this.connections.amqp.api}`;
    }

    async listQueues(chain: string, options: QueueListOptions = {}): Promise<QueueInfo[]> {
        try {
            const vhost = encodeURIComponent(this.connections.amqp.vhost);
            const url = `${this.getApiUrl()}/api/queues/${vhost}`;

            const response = await fetch(url, {
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const allQueues: QueueInfo[] = await response.json();

            // Apply client-side filtering for precise matching
            let filteredQueues = allQueues;
            
            if (!options.showAll && chain) {
                // Filter to only get queues that start with the chain prefix
                filteredQueues = allQueues.filter(queue => queue.name.startsWith(`${chain}:`));
            }

            // Apply additional filters
            if (options.filterPattern) {
                const pattern = new RegExp(options.filterPattern, 'i');
                filteredQueues = filteredQueues.filter(queue =>
                    pattern.test(queue.name)
                );
            }

            if (!options.showEmpty) {
                filteredQueues = filteredQueues.filter(queue => queue.messages > 0);
            }

            // Sort queues
            if (options.sortBy) {
                filteredQueues.sort((a, b) => {
                    switch (options.sortBy) {
                        case 'messages':
                            return b.messages - a.messages;
                        case 'consumers':
                            return b.consumers - a.consumers;
                        case 'name':
                        default:
                            return a.name.localeCompare(b.name);
                    }
                });
            } else {
                // Default sort by name
                filteredQueues.sort((a, b) => a.name.localeCompare(b.name));
            }

            return filteredQueues;
        } catch (error: any) {
            throw new Error(`Failed to list queues: ${error.message}`);
        }
    }

    async getQueueDetails(queueName: string): Promise<QueueInfo | null> {
        try {
            const vhost = encodeURIComponent(this.connections.amqp.vhost);
            const encodedQueueName = encodeURIComponent(queueName);
            const url = `${this.getApiUrl()}/api/queues/${vhost}/${encodedQueueName}`;

            const response = await fetch(url, {
                headers: this.getAuthHeaders()
            });

            if (response.status === 404) {
                return null;
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return await response.json();
        } catch (error: any) {
            throw new Error(`Failed to get queue details: ${error.message}`);
        }
    }

    async purgeQueue(queueName: string): Promise<void> {
        try {
            const vhost = encodeURIComponent(this.connections.amqp.vhost);
            const encodedQueueName = encodeURIComponent(queueName);
            const url = `${this.getApiUrl()}/api/queues/${vhost}/${encodedQueueName}/contents`;

            const response = await fetch(url, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error: any) {
            throw new Error(`Failed to purge queue: ${error.message}`);
        }
    }

    async deleteQueue(queueName: string): Promise<void> {
        try {
            const vhost = encodeURIComponent(this.connections.amqp.vhost);
            const encodedQueueName = encodeURIComponent(queueName);
            const url = `${this.getApiUrl()}/api/queues/${vhost}/${encodedQueueName}`;

            const response = await fetch(url, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error: any) {
            throw new Error(`Failed to delete queue: ${error.message}`);
        }
    }

    formatQueueList(queues: QueueInfo[], verbose: boolean = false): void {
        if (queues.length === 0) {
            console.log('No queues found matching the criteria.');
            return;
        }

        if (verbose) {
            // Detailed view
            console.log(`\n${'Queue Name'.padEnd(50)} ${'Messages'.padStart(10)} ${'Consumers'.padStart(11)} ${'Memory'.padStart(10)} ${'State'.padStart(8)}`);
            console.log('-'.repeat(95));

            for (const queue of queues) {
                const memoryMB = (queue.memory / 1024 / 1024).toFixed(2);
                console.log(
                    `${queue.name.padEnd(50)} ${queue.messages.toString().padStart(10)} ${queue.consumers.toString().padStart(11)} ${memoryMB.padStart(8)}MB ${queue.state.padStart(8)}`
                );
            }
        } else {
            // Compact view
            console.log(`\n${'Queue Name'.padEnd(50)} ${'Messages'.padStart(10)} ${'Consumers'.padStart(11)}`);
            console.log('-'.repeat(75));

            for (const queue of queues) {
                console.log(
                    `${queue.name.padEnd(50)} ${queue.messages.toString().padStart(10)} ${queue.consumers.toString().padStart(11)}`
                );
            }
        }

        // Summary
        const totalMessages = queues.reduce((sum, queue) => sum + queue.messages, 0);
        const totalConsumers = queues.reduce((sum, queue) => sum + queue.consumers, 0);
        const totalMemory = queues.reduce((sum, queue) => sum + queue.memory, 0);

        console.log('-'.repeat(verbose ? 95 : 75));
        console.log(`Total Queues: ${queues.length} | Total Messages: ${totalMessages} | Total Consumers: ${totalConsumers}${verbose ? ` | Total Memory: ${(totalMemory / 1024 / 1024).toFixed(2)}MB` : ''}`);
    }

    categorizeQueues(queues: QueueInfo[]): Record<string, QueueInfo[]> {
        const categories: Record<string, QueueInfo[]> = {
            'Block Processing': [],
            'Action Indexing': [],
            'Delta Processing': [],
            'ABI Processing': [],
            'Live Processing': [],
            'DS Pool Workers': [],
            'Other': []
        };

        for (const queue of queues) {
            const name = queue.name;

            if (name.includes(':blocks:') || name.includes(':live_blocks')) {
                categories['Block Processing'].push(queue);
            } else if (name.includes(':index_actions:')) {
                categories['Action Indexing'].push(queue);
            } else if (name.includes(':index_deltas:') || name.includes(':deltas:')) {
                categories['Delta Processing'].push(queue);
            } else if (name.includes(':index_abis:') || name.includes(':abis:')) {
                categories['ABI Processing'].push(queue);
            } else if (name.includes(':ds_pool:')) {
                categories['DS Pool Workers'].push(queue);
            } else if (name.includes(':live') || name.includes(':stream')) {
                categories['Live Processing'].push(queue);
            } else {
                categories['Other'].push(queue);
            }
        }

        // Remove empty categories
        Object.keys(categories).forEach(key => {
            if (categories[key].length === 0) {
                delete categories[key];
            }
        });

        return categories;
    }

    formatCategorizedQueues(queues: QueueInfo[], verbose: boolean = false): void {
        const categories = this.categorizeQueues(queues);

        for (const [category, categoryQueues] of Object.entries(categories)) {
            console.log(`\n🔹 ${category}`);
            this.formatQueueList(categoryQueues, verbose);
        }
    }
}
