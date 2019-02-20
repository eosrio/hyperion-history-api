const queue_prefix = process.env.CHAIN;
const index_queue_prefix = queue_prefix + ':index';
const index_queues = [
    {type: 'action', name: index_queue_prefix + "_actions"},
    {type: 'transaction', name: index_queue_prefix + "_transactions"},
    {type: 'block', name: index_queue_prefix + "_blocks"},
    {type: 'abi', name: index_queue_prefix + "_abis"}
];

module.exports = {
    index_queues
};
