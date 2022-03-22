export class HyperionPlugin {
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
    // abstract processActionData(input: any): Promise<any>;
    initOnce() {
        // called only once
    }
    initHandlerMap() {
        return {};
    }
}
//# sourceMappingURL=hyperion-plugin.js.map