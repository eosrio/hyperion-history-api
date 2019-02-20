const action_blacklist = [
    'eosio:onblock',
    'eosio:setprods',
    'eosio.null:nonce',
    'blocktwitter:tweet'
];

module.exports = {
    action_blacklist
};
