const config = require(`../${process.env.CONFIG_JSON}`);
let EOSIO_ALIAS = 'eosio';
if (config.settings.eosio_alias) {
    EOSIO_ALIAS = config.settings.eosio_alias;
}
const chain = config.settings.chain;
const delta_blacklist = new Set([]);

// chain::contract::action
const action_blacklist = new Set([
    chain + '::' + EOSIO_ALIAS + '::onblock',
    chain + '::' + EOSIO_ALIAS + '.null::*',
    // 'eos::eidosonecoin::*'
]);

module.exports = {
    action_blacklist,
    delta_blacklist
};
