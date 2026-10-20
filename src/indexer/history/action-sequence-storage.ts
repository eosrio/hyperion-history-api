import type {Client, estypes} from '@elastic/elasticsearch';
import {normalizeActionSequences} from '../helpers/action-sequences.js';
import {canonicalUint64, compatibleUint64} from '../helpers/uint64.js';

export const ACTION_SEQUENCE_NAMESPACE = 'h45_sequences_v1';
const signedMaximum = '9223372036854775807';
const signedIntegerMaximum = 0x7fffffff;
const counters = ['code_sequence', 'abi_sequence'] as const;
type Metadata = Record<string, any>;

export class ActionSequenceStorageError extends Error {
    readonly code = 'HYPERION_ACTION_SEQUENCE_STORAGE_INVALID';
    constructor(message: string) {
        super(message);
        this.name = 'ActionSequenceStorageError';
    }
}

function object(value: unknown): Metadata {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ActionSequenceStorageError('Invalid action sequence metadata object');
    }
    return value as Metadata;
}

function known(value: unknown, required: readonly string[], optional: readonly string[] = []): Metadata {
    const metadata = object(value);
    if (required.some(field => !Object.hasOwn(metadata, field)) ||
        Object.keys(metadata).some(field => !required.includes(field) && !optional.includes(field))) {
        throw new ActionSequenceStorageError('Incomplete or unknown exact action sequence metadata');
    }
    return metadata;
}

function sequence(value: unknown, positive = false): string {
    const text = canonicalUint64(value);
    if (positive && text === '0') throw new ActionSequenceStorageError('Committed action global sequence must be positive');
    return text;
}

function name(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new ActionSequenceStorageError('Missing action sequence receiver or authorization account');
    }
    return value;
}

function uint32(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new ActionSequenceStorageError('Expected a numeric uint32 action code or ABI counter');
    }
    return value;
}

const representable = (value: string) => value.length < signedMaximum.length ||
    (value.length === signedMaximum.length && value <= signedMaximum);
const pair = (value: unknown, positive = false) => {
    const text = sequence(value, positive);
    return {value: text, key: text.padStart(20, '0')};
};

function copy<T extends Metadata>(value: T): T {
    object(value);
    return structuredClone(value);
}

function guarded<T>(work: () => T): T {
    try {return work();} catch (error) {
        if (error instanceof ActionSequenceStorageError) throw error;
        throw new ActionSequenceStorageError('Invalid action sequence storage: ' +
            (error instanceof Error ? error.message : String(error)));
    }
}

function encodeCounters(source: Metadata, exact: Metadata): void {
    for (const field of counters) if (Object.hasOwn(source, field)) {
        const value = uint32(source[field]);
        exact[field] = value;
        if (value > signedIntegerMaximum) delete source[field];
    }
}

function encodeLeaf(source: Metadata, field: string, positive = false) {
    const value = pair(source[field], positive);
    if (!representable(value.value)) delete source[field];
    return value;
}

/**
 * Produces a separate physical clone. Contract data and plugin annotations are opaque;
 * only known sequence metadata leaves may be removed from their legacy signed mappings.
 * The input is a committed grouped action, not a raw SHIP receipt variant.
 */
export function encodeActionSequenceStorage<T extends Metadata>(logical: T): Metadata {
    return guarded(() => {
        const physical: Metadata = copy(logical);
        if (Object.hasOwn(physical, ACTION_SEQUENCE_NAMESPACE) || Object.hasOwn(physical, 'receipt') ||
            !Array.isArray(physical.receipts) || physical.receipts.length === 0) {
            throw new ActionSequenceStorageError('Expected complete grouped logical action sequence metadata');
        }
        const exact: Metadata = {version: 1, global: encodeLeaf(physical, 'global_sequence', true),
            receipts: physical.receipts.map((input: unknown, index: number) => {
                const receipt = object(input);
                if (!Array.isArray(receipt.auth_sequence)) {
                    throw new ActionSequenceStorageError('Incomplete action authorization sequences');
                }
                const result: Metadata = {index, receiver: name(receipt.receiver), global: encodeLeaf(receipt, 'global_sequence', true),
                    receive: encodeLeaf(receipt, 'recv_sequence'),
                    authorization: receipt.auth_sequence.map((input: unknown, index: number) => {
                        const authorization = object(input);
                        return {index, account: name(authorization.account), sequence: encodeLeaf(authorization, 'sequence')};
                    })};
                encodeCounters(receipt, result);
                return result;
            })};
        encodeCounters(physical, exact);
        physical[ACTION_SEQUENCE_NAMESPACE] = exact;
        return physical;
    });
}

function decodedPair(input: unknown, positive = false): string {
    const exact = known(input, ['value', 'key']);
    const value = sequence(exact.value, positive);
    if (exact.key !== value.padStart(20, '0')) throw new ActionSequenceStorageError('Exact action sequence key mismatch');
    return value;
}

function restoreLeaf(target: Metadata, field: string, input: unknown, positive = false): void {
    const value = decodedPair(input, positive), retained = Object.hasOwn(target, field);
    if (retained !== representable(value) || (retained && compatibleUint64(target[field]) !== value)) {
        throw new ActionSequenceStorageError('Legacy and exact action sequence copies disagree: ' + field);
    }
    target[field] = value;
}

function restoreCounters(target: Metadata, exact: Metadata): void {
    for (const field of counters) {
        if (!Object.hasOwn(exact, field)) {
            if (Object.hasOwn(target, field)) throw new ActionSequenceStorageError('Missing exact action counter: ' + field);
            continue;
        }
        const value = uint32(exact[field]), retained = Object.hasOwn(target, field);
        if (retained !== (value <= signedIntegerMaximum) || (retained && uint32(target[field]) !== value)) {
            throw new ActionSequenceStorageError('Legacy and exact action counter copies disagree: ' + field);
        }
        target[field] = value;
    }
}

function validateLegacyReceipt(input: unknown): void {
    const receipt = object(input);
    if (Object.hasOwn(receipt, 'global_sequence')) sequence(receipt.global_sequence, true);
    for (const field of counters) if (Object.hasOwn(receipt, field)) uint32(receipt[field]);
}

/**
 * Returns a separate logical clone with the reserved namespace removed. A present
 * namespace is validated completely and never falls back to retained numeric values.
 * Callers using _source filtering must fetch the whole namespace, receipts (including
 * authorization accounts/order), root global_sequence and root code/ABI counters;
 * apply the caller's original source projection only after restoration.
 * Legacy decoding alone makes no assertion about source-range completeness.
 */
export function restoreActionSequenceStorage<T extends Metadata>(physical: T): T {
    return guarded(() => {
        const logical = copy(physical);
        if (!Object.hasOwn(logical, ACTION_SEQUENCE_NAMESPACE)) {
            normalizeActionSequences(logical);
            sequence(logical.global_sequence, true);
            for (const field of counters) if (Object.hasOwn(logical, field)) uint32(logical[field]);
            if (Array.isArray(logical.receipts)) for (const receipt of logical.receipts) validateLegacyReceipt(receipt);
            if (logical.receipt !== undefined && logical.receipt !== null) {
                validateLegacyReceipt(Array.isArray(logical.receipt) ? logical.receipt[1] : logical.receipt);
            }
            return logical;
        }
        const exact = known(logical[ACTION_SEQUENCE_NAMESPACE], ['version', 'global', 'receipts'], counters);
        if (exact.version !== 1 || !Array.isArray(exact.receipts) || exact.receipts.length === 0 ||
            !Array.isArray(logical.receipts) || logical.receipts.length !== exact.receipts.length || Object.hasOwn(logical, 'receipt')) {
            throw new ActionSequenceStorageError('Incomplete exact grouped action sequence metadata');
        }
        restoreLeaf(logical, 'global_sequence', exact.global, true);
        restoreCounters(logical, exact);
        for (let index = 0; index < exact.receipts.length; index++) {
            const receipt = object(logical.receipts[index]);
            const stored = known(exact.receipts[index], ['index', 'receiver', 'global', 'receive', 'authorization'], counters);
            if (stored.index !== index || name(stored.receiver) !== name(receipt.receiver) ||
                !Array.isArray(receipt.auth_sequence) || !Array.isArray(stored.authorization) ||
                receipt.auth_sequence.length !== stored.authorization.length) {
                throw new ActionSequenceStorageError('Exact action receipt association mismatch');
            }
            restoreLeaf(receipt, 'global_sequence', stored.global, true);
            restoreLeaf(receipt, 'recv_sequence', stored.receive);
            restoreCounters(receipt, stored);
            for (let index = 0; index < stored.authorization.length; index++) {
                const authorization = object(receipt.auth_sequence[index]);
                const storedAuthorization = known(stored.authorization[index], ['index', 'account', 'sequence']);
                if (storedAuthorization.index !== index || name(storedAuthorization.account) !== name(authorization.account)) {
                    throw new ActionSequenceStorageError('Exact action authorization association mismatch');
                }
                restoreLeaf(authorization, 'sequence', storedAuthorization.sequence);
            }
        }
        delete logical[ACTION_SEQUENCE_NAMESPACE];
        return logical;
    });
}

/** A fresh mapping object avoids configuration/plugin code mutating a shared singleton. */
export function actionSequenceMapping(): estypes.MappingProperty {
    const scalar = (): estypes.MappingProperty => ({type: 'object', dynamic: 'strict',
        properties: {value: {type: 'unsigned_long'}, key: {type: 'keyword'}}});
    return {type: 'object', dynamic: 'strict', properties: {
        version: {type: 'byte'}, global: scalar(), code_sequence: {type: 'long'}, abi_sequence: {type: 'long'},
        receipts: {type: 'object', dynamic: 'strict', properties: {
            index: {type: 'integer'}, receiver: {type: 'keyword'}, global: scalar(), receive: scalar(),
            code_sequence: {type: 'long'}, abi_sequence: {type: 'long'},
            authorization: {type: 'object', dynamic: 'strict', properties: {
                index: {type: 'integer'}, account: {type: 'keyword'}, sequence: scalar()}}
        }}
    }};
}

function assertNamespaceMapping(actual: unknown, expected: estypes.MappingProperty = actionSequenceMapping()): void {
    const value = object(actual), wanted = expected as Metadata;
    const invalidType = wanted.type === 'object' ? value.type !== undefined && value.type !== 'object' : value.type !== wanted.type;
    if (invalidType || value.enabled === false || value.index === false || value.doc_values === false ||
        value.ignore_malformed === true || value.normalizer !== undefined || value.ignore_above !== undefined ||
        value.null_value !== undefined || value.script !== undefined || value.copy_to !== undefined || value.fields !== undefined ||
        value.subobjects === false) {
        throw new ActionSequenceStorageError('Incompatible exact action sequence mapping');
    }
    if (wanted.properties) {
        const properties = object(value.properties);
        if (value.dynamic !== 'strict' || Object.keys(properties).length !== Object.keys(wanted.properties).length) {
            throw new ActionSequenceStorageError('Incomplete or non-strict exact action sequence mapping');
        }
        for (const [field, mapping] of Object.entries(wanted.properties)) assertNamespaceMapping(properties[field], mapping as estypes.MappingProperty);
    }
}

function assertLegacyMappings(mapping: Metadata): void {
    const properties = object(mapping.properties);
    if (mapping.enabled === false || mapping.subobjects === false || properties.global_sequence?.type !== 'long') {
        throw new ActionSequenceStorageError('Incompatible retained action root sequence mapping');
    }
    for (const field of counters) if (properties[field] && !['integer', 'long'].includes(properties[field].type)) {
        throw new ActionSequenceStorageError('Incompatible retained action counter mapping');
    }
    const receipts = properties.receipts;
    if (receipts !== undefined) {
        if (receipts.enabled === false || (receipts.type !== undefined && receipts.type !== 'object')) {
            throw new ActionSequenceStorageError('Incompatible retained action receipt mapping');
        }
        const fields = object(receipts.properties);
        for (const field of ['global_sequence', 'recv_sequence']) if (fields[field] && fields[field].type !== 'long') {
            throw new ActionSequenceStorageError('Incompatible retained action receipt sequence mapping');
        }
        const authorization = fields.auth_sequence;
        if (authorization && (authorization.enabled === false || (authorization.type !== undefined && authorization.type !== 'object') ||
            (authorization.properties?.sequence && authorization.properties.sequence.type !== 'long'))) {
            throw new ActionSequenceStorageError('Incompatible retained action authorization sequence mapping');
        }
    }
}

const settingsValue = (entry: Metadata, field: string): unknown => {
    for (const values of [entry.settings, entry.defaults]) {
        if (!values) continue;
        if (Object.hasOwn(values, 'index.' + field)) return values['index.' + field];
        if (Object.hasOwn(values, field)) return values[field];
        let value = values.index;
        if (value && Object.hasOwn(value, field)) return value[field];
        for (const segment of field.split('.')) value = value?.[segment];
        if (value !== undefined) return value;
    }
    return undefined;
};

// Elasticsearch9.5.5's include_defaults response uses STORED, while explicit
// mapping/settings inputs use stored. Accept these known enum forms only.
const storedSourceMode = (value: unknown): boolean => value === undefined || value === 'stored' || value === 'STORED';

function assertSourceRetention(mapping: Metadata, settings: Metadata): void {
    const source = mapping._source;
    if (mapping.enabled === false || source?.enabled === false || !storedSourceMode(source?.mode) ||
        ['includes', 'excludes'].some(field => source?.[field] !== undefined &&
            (!Array.isArray(source[field]) || source[field].length !== 0)) ||
        !storedSourceMode(settingsValue(settings, 'mapping.source.mode'))) {
        throw new ActionSequenceStorageError('Exact action sequences require complete stored _source retention');
    }
    const pipeline = settingsValue(settings, 'final_pipeline');
    if (pipeline !== undefined && pipeline !== '_none') {
        throw new ActionSequenceStorageError('Unqualified action final pipeline may alter exact sequence metadata');
    }
    // The opt-in writer always supplies pipeline:_none, bypassing an operator's default pipeline.
}

const mappingFilter = ['*.mappings.enabled', '*.mappings.subobjects', '*.mappings._source',
    '*.mappings.properties.' + ACTION_SEQUENCE_NAMESPACE, '*.mappings.properties.global_sequence',
    '*.mappings.properties.code_sequence', '*.mappings.properties.abi_sequence',
    '*.mappings.properties.receipts.type', '*.mappings.properties.receipts.enabled',
    '*.mappings.properties.receipts.properties.global_sequence', '*.mappings.properties.receipts.properties.recv_sequence',
    '*.mappings.properties.receipts.properties.auth_sequence.type', '*.mappings.properties.receipts.properties.auth_sequence.enabled',
    '*.mappings.properties.receipts.properties.auth_sequence.properties.sequence'];

function ownedMapping(response: estypes.IndicesGetMappingResponse, index: string): Metadata {
    if (Object.keys(response).length !== 1 || !response[index]?.mappings) {
        throw new ActionSequenceStorageError('Action sequence mapping readback mismatch: ' + index);
    }
    return response[index].mappings;
}

async function indexSettings(client: Client, index: string): Promise<Metadata> {
    const response = await client.indices.getSettings({index, flat_settings: true, include_defaults: true});
    if (Object.keys(response).length !== 1 || !response[index]) {
        throw new ActionSequenceStorageError('Action sequence settings readback mismatch: ' + index);
    }
    return response[index];
}

/**
 * Opt-in startup guard, before ingestion workers. Discovery returns names only;
 * individual filtered metadata reads avoid returning unrelated contract mappings.
 * All targets are preflighted before any additive effect. Write-blocked legacy
 * partitions are not rewritten and remain subject to the read adapter's coverage gate.
 */
export async function ensureActionSequenceMappings(client: Client, chain: string): Promise<{inspected: number; updated: number}> {
    if (!/^[a-z0-9][a-z0-9_.-]{0,120}$/.test(chain)) throw new ActionSequenceStorageError('Invalid action sequence mapping chain');
    const prefix = chain + '-action-';
    const resolved = await client.indices.resolveIndex({name: prefix + '*', expand_wildcards: ['open', 'hidden'],
        allow_no_indices: true, ignore_unavailable: false});
    if (!Array.isArray(resolved.indices) || !Array.isArray(resolved.data_streams) || resolved.data_streams.length !== 0) {
        throw new ActionSequenceStorageError('Action sequence storage cannot use an unresolved index or data stream');
    }
    const names = resolved.indices.map(entry => entry.name);
    if (new Set(names).size !== names.length || names.some(index => !index.startsWith(prefix) || index.length === prefix.length)) {
        throw new ActionSequenceStorageError('Unowned action index in sequence mapping response');
    }
    const targets: Array<{index: string; uuid: unknown; missing: boolean; readOnly: boolean}> = [];
    for (const index of names) {
        const settings = await indexSettings(client, index);
        const mapping = ownedMapping(await client.indices.getMapping({index, filter_path: mappingFilter}), index);
        assertLegacyMappings(mapping);
        const current = mapping.properties?.[ACTION_SEQUENCE_NAMESPACE];
        if (current !== undefined) assertNamespaceMapping(current);
        const readOnly = ['true', true].includes(settingsValue(settings, 'blocks.write') as any);
        if (!readOnly) assertSourceRetention(mapping, settings);
        const uuid = settingsValue(settings, 'uuid');
        if (typeof uuid !== 'string' || uuid.length === 0) throw new ActionSequenceStorageError('Missing action index generation identity');
        targets.push({index, uuid, missing: current === undefined, readOnly});
    }
    let updated = 0;
    for (const target of targets) {
        if (!target.missing || target.readOnly) continue;
        const receipt = await client.indices.putMapping({index: target.index, properties: {[ACTION_SEQUENCE_NAMESPACE]: actionSequenceMapping()}});
        if (receipt.acknowledged !== true) throw new ActionSequenceStorageError('Action sequence mapping update was not acknowledged: ' + target.index);
        const mapping = ownedMapping(await client.indices.getMapping({index: target.index, filter_path: mappingFilter}), target.index);
        if (mapping.properties?.[ACTION_SEQUENCE_NAMESPACE] === undefined) {
            throw new ActionSequenceStorageError('Action sequence mapping readback is missing the exact namespace: ' + target.index);
        }
        assertNamespaceMapping(mapping.properties?.[ACTION_SEQUENCE_NAMESPACE]);
        assertLegacyMappings(mapping);
        const settings = await indexSettings(client, target.index);
        assertSourceRetention(mapping, settings);
        if (settingsValue(settings, 'uuid') !== target.uuid) throw new ActionSequenceStorageError('Action index generation changed during sequence initialization');
        updated++;
    }
    return {inspected: targets.length, updated};
}

/** Named template readback follows the Elasticsearch index_templates wrapper. */
export function assertActionSequenceTemplateReadback(response: unknown, templateName: string): void {
    const templates = object(response).index_templates;
    const patterns = templates?.[0]?.index_template?.index_patterns;
    if (!Array.isArray(templates) || templates.length !== 1 || templates[0]?.name !== templateName ||
        !Array.isArray(patterns) || patterns.length !== 1 || patterns[0] !== templateName + '-*') {
        throw new ActionSequenceStorageError('Action sequence template readback mismatch: ' + templateName);
    }
    assertNamespaceMapping(templates[0].index_template?.template?.mappings?.properties?.[ACTION_SEQUENCE_NAMESPACE]);
}

/** Read the effective future partition template, including higher-priority operator templates. */
export async function ensureActionSequenceWriteTemplate(client: Client, index: string): Promise<void> {
    const response = await client.indices.simulateIndexTemplate({name: index});
    const template = object(response.template), mapping = object(template.mappings);
    assertLegacyMappings(mapping);
    assertNamespaceMapping(mapping.properties?.[ACTION_SEQUENCE_NAMESPACE]);
    assertSourceRetention(mapping, {settings: template.settings});
}
