import assert from 'node:assert/strict';
import {STATEFUL_FAMILY} from '@eosrio/hyperion-sdk/projection-stateful';

export const PROJECTION_ID = 'wire-sysio-msgch-owner-v2';
const contract = 'sysio.msgch';
const kinds = Object.freeze({attseq: 'attseq', outenvelopes: 'envelope'});
const clone = value => JSON.parse(JSON.stringify(value));
const uint64 = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)
    && BigInt(value) <= 18446744073709551615n;
const hex = value => typeof value === 'string' && /^(?:[0-9a-f]{2})+$/.test(value) && value.length <= 256;

/** The original physical table ID and every raw-key byte participate; there is no synthetic scope. */
export function wireRecordKey(identity) {
    assert.ok(['kv-primary', 'kv-secondary'].includes(identity?.kind), 'Wire probe requires an original KV identity');
    assert.ok(Number.isInteger(identity.tableId) && identity.tableId >= 0 && identity.tableId <= 65535);
    if (identity.kind === 'kv-secondary') {
        assert.ok(hex(identity.secondaryKeyHex) && hex(identity.primaryKeyHex), 'Original secondary/primary key bytes are required');
        assert.deepEqual(Object.keys(identity).sort(), ['kind', 'primaryKeyHex', 'secondaryKeyHex', 'tableId']);
        return JSON.stringify([identity.kind, identity.tableId, identity.secondaryKeyHex, identity.primaryKeyHex]);
    }
    assert.ok(hex(identity.keyHex), 'Original Wire key bytes are required');
    assert.deepEqual(Object.keys(identity).sort(), ['keyHex', 'kind', 'tableId']);
    return JSON.stringify([identity.kind, identity.tableId, identity.keyHex]);
}

function valueFor(input) {
    const value = input.data;
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Present Wire row has no decoded value');
    assert.ok(uint64(value.id), 'Wire row ID must remain an exact uint64 string');
    const common = {id: value.id, identity: clone(input.identity), payer: input.payer};
    assert.ok(common.payer === null || typeof common.payer === 'string');
    if (input.name === 'attseq') {
        assert.ok(uint64(value.next), 'Attestation sequence must remain an exact uint64 string');
        return {...common, next: value.next};
    }
    assert.ok(Number.isSafeInteger(value.epoch_index) && value.epoch_index >= 0, 'Invalid decoded envelope epoch');
    assert.ok(uint64(value.chain_code), 'Envelope chain code must remain an exact uint64 string');
    assert.ok(typeof value.status === 'string' && value.status.length > 0 && Buffer.byteLength(value.status) <= 128);
    assert.ok(typeof value.envelope_hash === 'string' && /^[0-9a-f]{64}$/.test(value.envelope_hash));
    return {...common, epoch_index: value.epoch_index, chain_code: value.chain_code,
        status: value.status, envelope_hash: value.envelope_hash};
}

/** Qualification only: source/canonical/ABI/owner/recovery/HTTP authority belongs to the real HAPI host. */
export default class WireManagedStateQualification {
    internalPluginName = 'wire-managed-state-qualification';
    constructor(options) {
        assert.equal(options?.enabled, true);
        assert.equal(options.qualificationOnly, true, 'Explicit qualification-only activation required');
        assert.ok(options.limits && typeof options.limits === 'object', 'Explicit SDK limits required');
        this.limits = clone(options.limits);
    }
    getStatefulProjectionsV2() {
        return {interfaceVersion: 2, sourceInputVersion: 2, projections: [{
            definition: {family: STATEFUL_FAMILY, interfaceVersion: 1, id: PROJECTION_ID,
                selectors: Object.keys(kinds).map(name => ({id: contract + ':' + name, kind: 'table', contract, name})),
                records: [{kind: 'attseq', integers: [
                    {path: ['id'], type: 'uint64', vector: false}, {path: ['next'], type: 'uint64', vector: false}]},
                    {kind: 'envelope', integers: [
                        {path: ['id'], type: 'uint64', vector: false}, {path: ['chain_code'], type: 'uint64', vector: false}]},
                    {kind: 'secondary', integers: []}]},
            limits: clone(this.limits),
            reduce: async port => {
                for (const input of port.source.inputs) {
                    assert.equal(input.kind, 'table'); assert.equal(input.contract, contract);
                    assert.ok(Object.hasOwn(kinds, input.name), 'Unexpected selected Wire table');
                    const key = wireRecordKey(input.identity);
                    if (input.identity.kind === 'kv-secondary') {
                        assert.equal(input.data, null, 'An original secondary entry has no decoded primary row');
                        if (input.present) port.put('secondary', key, {table: input.name, identity: clone(input.identity), payer: input.payer});
                        else port.delete('secondary', key);
                        continue;
                    }
                    const kind = kinds[input.name];
                    if (input.present) port.put(kind, key, valueFor(input));
                    else port.delete(kind, key);
                }
            }
        }]};
    }
    addRoutes(router, context) {
        assert.equal(typeof context?.statefulQueryHost, 'function', 'Managed request-local query authority required');
        router.get('/v2/qualification/wire/:table/:tableId/:keyHex', async (request, reply) => {
            let status = 200;
            const result = await context.statefulQueryHost(request).compose(PROJECTION_ID, async port => {
                const {table, tableId, keyHex} = request.params;
                if (!Object.hasOwn(kinds, table) || !/^(?:0|[1-9][0-9]*)$/.test(tableId)
                    || Number(tableId) > 65535 || !hex(keyHex)) {
                    status = 400; return {qualificationOnly: true, error: 'Invalid original Wire table identity'};
                }
                const identity = {kind: 'kv-primary', tableId: Number(tableId), keyHex};
                const row = await port.get(kinds[table], wireRecordKey(identity));
                return {qualificationOnly: true, table, identity, row: row.status === 'present' ? row.value : null};
            });
            return reply.code(status).send(result.value);
        });
    }
}
