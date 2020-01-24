const config = require(`../${process.env.CONFIG_JSON}`);
const chain = config.settings.chain;

const delta_whitelist = new Set([]);

const action_whitelist = new Set([
    // chain + '::eosio::newaccount'
    // chain + '::eosio.token::transfer'
]);

module.exports = {
    action_whitelist,
    delta_whitelist
};
