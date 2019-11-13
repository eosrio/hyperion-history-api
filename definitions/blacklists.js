const chain_prefix = process.env.CHAIN;

const delta_blacklist = new Set([

]);

// chain::contract::action
const action_blacklist = new Set([
    chain_prefix + '::eosio::onblock',
    chain_prefix + '::eosio.null::*'
]);

module.exports = {
    action_blacklist,
    delta_blacklist
};
