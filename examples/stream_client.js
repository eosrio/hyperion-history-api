const HyperionSocketClient = require('@eosrio/hyperion-stream-client').default;

const client = new HyperionSocketClient('https://wax.hyperion.eosrio.io', {async: true});

let totalMessages = 0;
let messages = 0;

const pastMsgInterval = setInterval(() => {
    if (messages === 0) {
        console.log(`Total Messages Received: ${totalMessages}`);
        if (totalMessages !== 0) {
            clearInterval(pastMsgInterval);
        }
    } else {
        totalMessages += messages;
        console.log(`Incoming Rate: ${messages / 5} msg/s`);
        messages = 0;
    }
}, 5000);

client.onConnect = () => {
    client.streamDeltas({
        code: 'eosio',
        table: 'global',
        scope: '',
        payer: '',
        start_from: '2020-04-27T00:00:00.000', // start to fetch 100 blocks behind the head
        read_until: 0,
    });
}

client.onData = async (data, ack) => {
    const content = data.content;

    if (data.type === 'delta') {
        if (content['present'] === true) {
            const delta_data = content.data;
            console.log(`\n >>>> Block: ${content['block_num']} | Contract: ${content.code} | Table: ${content.table} | Scope: ${content['scope']} | Payer: ${content['payer']} <<<< `);
            if (delta_data) {
                for (const key in delta_data) {
                    if (delta_data.hasOwnProperty(key)) {
                        //console.log(`${key} = ${delta_data[key]}`);
                    }
                }
            } else {
                console.log('ERROR >>>>>>>> ', content);
            }
        }
    }

    if (data.type === 'action') {
        const act = data.content['act'];
        console.lopoisg(`\n >>>> Contract: ${act.account} | Action: ${act.name} | Block: ${content['block_num']} <<<< `);
        for (const key in act.data) {
            if (act.data.hasOwnProperty(key)) {
                console.log(`${key} = ${act.data[key]}`);
            }
        }
    }

    messages++;
    console.log('______________________');

    //console.log(data); // process incoming data, replace with your code
    ack(); // ACK when done
}

client.connect(() => {
    console.log('connected!');
});