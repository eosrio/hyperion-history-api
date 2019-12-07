const fs = require('fs');
const path = require('path');
const chainID = require('../connections.json').chains[process.env.CHAIN]['chain_id'];

class HyperionModuleLoader {

    #handledActions = new Map();
    actionParser;
    chainMappings = new Map();
    extraMappings = [];

    constructor() {
        this.loadActionHandlers();
        const parsers = require(path.join(__dirname, 'parsers', process.env.PARSER + "-parser"));
        this.actionParser = parsers.actionParser;
        this.messageParser = parsers.messageParser;
    }

    processActionData(action) {
        const wildcard = this.#handledActions.get('*');
        if (wildcard.has(action.act.name)) {
            wildcard.get(action.act.name)(action);
        }
        if (this.#handledActions.has(action.act.account)) {
            const _c = this.#handledActions.get(action.act.account);
            if (_c.has(action.act.name)) {
                _c.get(action.act.name)(action);
            }
        }
    }

    includeModule(_module) {
        if (this.#handledActions.has(_module.contract)) {
            const existing = this.#handledActions.get(_module.contract);
            existing.set(_module.action, _module.handler);
        } else {
            const _map = new Map();
            _map.set(_module.action, _module.handler);
            this.#handledActions.set(_module.contract, _map);
        }
        if (_module.mappings) {
            this.extraMappings.push(_module.mappings);
        }
    }

    loadActionHandlers() {
        const files = fs.readdirSync('modules/action_data/');
        for (const plugin of files) {
            const _module = require(path.join(__dirname, 'action_data', plugin)).hyperionModule;
            if (_module.parser_version.includes(process.env.PARSER)) {
                if (_module.chain === chainID || _module.chain === '*') {
                    const key = `${_module.contract}::${_module.action}`;
                    if (this.chainMappings.has(key)) {
                        if (this.chainMappings.get(key) === '*' && _module.chain === chainID) {
                            // console.log('Overwriting module ' + key + ' for ' + _module.chain);
                            this.includeModule(_module);
                            this.chainMappings.set(key, _module.chain);
                        }
                    } else {
                        // console.log('Including module ' + key + ' for ' + _module.chain);
                        this.includeModule(_module);
                        this.chainMappings.set(key, _module.chain);
                    }
                }
            }
        }
    }
}

module.exports = {HyperionModuleLoader};
