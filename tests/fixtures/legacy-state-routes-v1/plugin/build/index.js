import assert from 'node:assert/strict';

export const PROJECTION_ID = 'legacy-state-routes-v1-fixture';
const clone = value => JSON.parse(JSON.stringify(value));

/** Test fixture only: a block-height projection that answers core state routes through HAPI's delegation. */
export default class LegacyStateRoutesFixture {
    internalPluginName = 'legacy-state-routes-fixture';
    constructor(options) {
        assert.equal(options?.enabled, true);
        assert.ok(options.template && options.limits, 'Explicit fixture template and SDK limits required');
        this.options = clone(options);
    }
    getStatefulProjectionsV2() {
        const {template, limits, requiredCompleteKindRead} = this.options;
        return {interfaceVersion: 2, sourceInputVersion: 2, projections: [{definition: {...template, id: PROJECTION_ID}, limits,
            requiredSourceCapabilities: [], ...(requiredCompleteKindRead ? {requiredCompleteKindRead} : {}),
            reduce: async port => {
                port.put('collection', 'last', {height: port.source.block.blockNum, occurrences: port.source.inputs.length});
            }}]};
    }
    getLegacyStateRoutesV1(context) {
        assert.equal(context.interfaceVersion, 1);
        assert.ok(context.routes.includes('get_tokens'));
        const routes = {get_tokens: {projectionId: PROJECTION_ID, read: 'keyed', compose: async (reader, request) => {
            const row = await reader.get('collection', 'last');
            return {account: request.query.account, tokens: row.status === 'present'
                ? [{symbol: 'HEIGHT', precision: 0, amount: row.value.height, contract: 'target'}] : []};
        }}};
        if (context.completeKindRead && this.options.requiredCompleteKindRead) routes.get_top_holders = {projectionId: PROJECTION_ID, read: 'complete-kind',
            compose: async (reader, request) => {
                const rows = await reader.all('collection');
                return {contract: request.query.contract, symbol: request.query.symbol ?? 'HEIGHT',
                    holders: rows.map(row => ({owner: row.key, amount: row.value.height, symbol: 'HEIGHT'}))};
            }};
        return {interfaceVersion: 1, routes};
    }
}
