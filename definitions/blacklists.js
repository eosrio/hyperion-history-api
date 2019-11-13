const chain_prefix = process.env.CHAIN;
const system_domain = process.env.SYSTEM_DOMAIN;

const delta_blacklist = new Set([

]);

// chain::contract::action
const action_blacklist = new Set([
    chain_prefix + '::' + system_domain + '::onblock',
    chain_prefix + '::' + system_domain + '.null::*'
]);

module.exports = {
    action_blacklist,
    delta_blacklist
};
