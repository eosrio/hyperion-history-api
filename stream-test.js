const WebSocket = require('ws');

const ws = new WebSocket('wss://br.eosrio.io/hyperion/stream_actions');

let traces = [];

ws.on('open', function open() {
    const request = {
        type: 'request',
        data: {
            account_name: 'bosriobrazil',
            filter: '',
            sort: 'desc',
            size: 5
        }
    };
    ws.send(JSON.stringify(request));
});


ws.on('message', function (data) {
    const doc = JSON.parse(data);
    console.log(doc);
});
