const chain_prefix = process.env.CHAIN;
const system_domain = process.env.SYSTEM_DOMAIN;

const delta_whitelist = new Set([]);

const action_whitelist = new Set([
    // chain_prefix + '::' + system_domain +'::newaccount'
    // chain_prefix + '::' + system_domain +'.token::transfer'
]);

module.exports = {
    action_whitelist,
    delta_whitelist
};
