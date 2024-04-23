"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HyperionPlugin = void 0;
class HyperionPlugin {
    constructor(config) {
        this.internalPluginName = '';
        this.indexerPlugin = false;
        this.apiPlugin = false;
        this.actionHandlers = [];
        this.deltaHandlers = [];
        this.streamHandlers = [];
        this.dynamicContracts = [];
        this.hasApiRoutes = false;
        this.chainName = '';
        if (config) {
            this.baseConfig = config;
        }
    }
    // abstract processActionData(input: any): Promise<any>;
    initOnce() {
        // called only once
    }
    initHandlerMap() {
        return {};
    }
}
exports.HyperionPlugin = HyperionPlugin;
//# sourceMappingURL=hyperion-plugin.js.map