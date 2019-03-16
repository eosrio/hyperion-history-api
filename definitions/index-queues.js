const queue_prefix = process.env.CHAIN;
const index_queue_prefix = queue_prefix + ':index';
const index_queues = [
    {type: 'action', name: index_queue_prefix + "_actions"},
    {type: 'block', name: index_queue_prefix + "_blocks"},
    {type: 'delta', name: index_queue_prefix + "_deltas"},
    {type: 'abi', name: index_queue_prefix + "_abis"}
];

module.exports = {
    index_queues
};
