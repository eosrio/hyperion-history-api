const chain_prefix = process.env.CHAIN;

const delta_whitelist = new Set([]);

const action_whitelist = new Set([
    // chain_prefix + '::eosio::newaccount'
    // chain_prefix + '::eosio.token::transfer'
]);

module.exports = {
    action_whitelist,
    delta_whitelist
};
