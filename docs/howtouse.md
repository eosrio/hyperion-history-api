# How to use

## JavaScript client using https

````javascript
const https = require('https');
const HYPERION = 'https://api.eossweden.org/v2/history/get_actions';
//PEGAR ARGS

````


````javascript
let getActions = function (args) {
    let url = HYPERION + args;
    return new Promise(function (resolve) {
        https.get(url, (resp) => {
            let data = '';

            // A chunk of data has been recieved.
            resp.on('data', (chunk) => {
                data += chunk;
            });

            // The whole response has been received. Print out the result.
            resp.on('end', () => {
                resolve(JSON.parse(data)['actions']);
            });
        });

    })
};
````

## Third party library
https://github.com/eoscafe/hyperion-api