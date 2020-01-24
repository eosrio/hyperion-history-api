const config = require(`../${process.env.CONFIG_JSON}`);
const chain = config.settings.chain;
const index_queue_prefix = chain + ':index';
const index_queues = [
    {type: 'action', name: index_queue_prefix + "_actions"},
    {type: 'block', name: index_queue_prefix + "_blocks"},
    {type: 'delta', name: index_queue_prefix + "_deltas"},
    {type: 'abi', name: index_queue_prefix + "_abis"}
];

module.exports = {
    index_queues
};
