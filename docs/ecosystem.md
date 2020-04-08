### Detailed description of the ecosystem.config.js

````javascript
const {addApiServer, addIndexer} = require("./definitions/ecosystem_settings");

module.exports = {
    apps: [
        addIndexer('eos'), // Index chain name
        addApiServer('eos', 1) // API chain name, API threads number
    ]
};
````


### Multiple chains configuration

To setup multiple Indexers and/or APIs, just add then inside the `apps` square brackets:

````javascript
const {addApiServer, addIndexer} = require("./definitions/ecosystem_settings");

module.exports = {
    apps: [
        addIndexer('eos'),
        addIndexer('wax'),
        addIndexer('bos'),
        addApiServer('eos', 1),
        addApiServer('bos', 1) 
    ]
};
````