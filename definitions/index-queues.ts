import {ConfigurationModule} from "../modules/config";

const cm = new ConfigurationModule();
const chain = cm.config.settings.chain;
const index_queue_prefix = chain + ':index';

export const index_queues = [
    {type: 'action', name: index_queue_prefix + "_actions"},
    {type: 'block', name: index_queue_prefix + "_blocks"},
    {type: 'delta', name: index_queue_prefix + "_deltas"},
    {type: 'abi', name: index_queue_prefix + "_abis"}
];

// Global Queue Definitions
export const RabbitQueueDef = {
    durable: false,
    arguments: {
        "x-queue-version": 2
    }
};