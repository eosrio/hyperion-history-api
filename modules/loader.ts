import {ConfigurationModule} from "./config";
import {join} from "path";
import {readdirSync} from "fs";
import {HyperionConnections} from "../interfaces/hyperionConnections";
import {HyperionConfig} from "../interfaces/hyperionConfig";

export class HyperionModuleLoader {

    private handledActions = new Map();
    actionParser;
    chainMappings = new Map();
    extraMappings = [];
    messageParser: any;
    chainID;
    private conn: HyperionConnections;
    private config: HyperionConfig;

    constructor(private cm: ConfigurationModule) {
        this.conn = cm.connections;
        this.config = cm.config;
        this.chainID = this.conn.chains[this.config.settings.chain].chain_id;
        this.loadActionHandlers();
        const parsers = require(join(__dirname, 'parsers', this.config.settings.parser + "-parser"));
        this.actionParser = parsers.actionParser;
        this.messageParser = parsers.messageParser;
    }

    processActionData(action) {
        const wildcard = this.handledActions.get('*');
        if (wildcard.has(action.act.name)) {
            wildcard.get(action.act.name)(action);
        }
        if (this.handledActions.has(action.act.account)) {
            const _c = this.handledActions.get(action.act.account);
            if (_c.has(action.act.name)) {
                _c.get(action.act.name)(action);
            }
        }
    }

    includeModule(_module) {
        if (this.handledActions.has(_module.contract)) {
            const existing = this.handledActions.get(_module.contract);
            existing.set(_module.action, _module.handler);
        } else {
            const _map = new Map();
            _map.set(_module.action, _module.handler);
            this.handledActions.set(_module.contract, _map);
        }
        if (_module.mappings) {
            this.extraMappings.push(_module.mappings);
        }
    }

    loadActionHandlers() {
        const files = readdirSync('modules/action_data/');
        for (const plugin of files) {
            const _module = require(join(__dirname, 'action_data', plugin)).hyperionModule;
            if (_module.parser_version.includes(this.config.settings.parser)) {
                if (_module.chain === this.chainID || _module.chain === '*') {
                    const key = `${_module.contract}::${_module.action}`;
                    if (this.chainMappings.has(key)) {
                        if (this.chainMappings.get(key) === '*' && _module.chain === this.chainID) {
                            this.includeModule(_module);
                            this.chainMappings.set(key, _module.chain);
                        }
                    } else {
                        this.includeModule(_module);
                        this.chainMappings.set(key, _module.chain);
                    }
                }
            }
        }
    }
}
