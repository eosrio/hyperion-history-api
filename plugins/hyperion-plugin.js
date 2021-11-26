"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HyperionPlugin = void 0;
class HyperionPlugin {
    constructor(config) {
        this.internalPluginName = '';
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
}
exports.HyperionPlugin = HyperionPlugin;
//# sourceMappingURL=hyperion-plugin.js.map