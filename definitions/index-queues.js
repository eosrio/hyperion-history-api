const queue_prefix = process.env.CHAIN;
const index_queue_prefix = queue_prefix + ':index';
const index_queues = [
    {type: 'action', name: index_queue_prefix + "_actions"},
    {type: 'block', name: index_queue_prefix + "_blocks"},
    {type: 'delta', name: index_queue_prefix + "_deltas"},
    {type: 'abi', name: index_queue_prefix + "_abis"},
    {type: 'table-accounts', name: index_queue_prefix + "_table_accounts"},
    {type: 'table-voters', name: index_queue_prefix + "_table_voters"},
    {type: 'table-delband', name: index_queue_prefix + "_table_delband"},
    {type: 'table-userres', name: index_queue_prefix + "_table_userres"}
];

module.exports = {
    index_queues
};
