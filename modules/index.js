const fs = require('fs');
const path = require('path');

class HyperionModuleLoader {

    #handledActions = new Map();
    actionParser;

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

    loadActionHandlers() {
        const files = fs.readdirSync('modules/action_data/');
        for (const plugin of files) {
            const _module = require(path.join(__dirname, 'action_data', plugin)).hyperionModule;
            if (_module.parser_version.includes(process.env.PARSER)) {
                if (this.#handledActions.has(_module.contract)) {
                    const existing = this.#handledActions.get(_module.contract);
                    existing.set(_module.action, _module.handler);
                } else {
                    const _map = new Map();
                    _map.set(_module.action, _module.handler);
                    this.#handledActions.set(_module.contract, _map);
                }
            }
        }
    }
}

module.exports = {HyperionModuleLoader};
