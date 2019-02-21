const action_blacklist = new Set([
    'eosio:onblock',
    'eosio:setprods',
    'eosio.null:nonce',
    'blocktwitter:tweet'
]);

module.exports = {
    action_blacklist
};
