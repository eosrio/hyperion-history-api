import {compatibleUint64, compareUint64, Uint64ValueError} from './uint64.js';
import type {RequestFilter} from '../../interfaces/stream-requests.js';

type MetadataObject = Record<string, any>;

function metadataObject(value: unknown): MetadataObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Uint64ValueError('Invalid action sequence metadata structure');
    }
    return value as MetadataObject;
}

function normalizeFields(value: MetadataObject, fields: readonly string[]): void {
    for (const field of fields) {
        if (Object.hasOwn(value, field)) value[field] = compatibleUint64(value[field]);
    }
}

function normalizeReceipt(value: unknown): void {
    const receipt = metadataObject(value);
    normalizeFields(receipt, ['global_sequence', 'recv_sequence']);
    if (Object.hasOwn(receipt, 'auth_sequence')) {
        if (!Array.isArray(receipt.auth_sequence)) throw new Uint64ValueError('Invalid action authorization sequences');
        for (const authorization of receipt.auth_sequence) normalizeFields(metadataObject(authorization), ['sequence']);
    }
}

/** Mutates known metadata leaves only; never derives the root identifier from notification order. */
export function normalizeActionSequences<T extends MetadataObject>(action: T): T {
    metadataObject(action);
    normalizeFields(action, ['global_sequence']);
    if (action.receipt !== undefined && action.receipt !== null) {
        if (Array.isArray(action.receipt)) {
            if (action.receipt.length !== 2 || typeof action.receipt[0] !== 'string') {
                throw new Uint64ValueError('Invalid SHIP action receipt variant');
            }
            normalizeReceipt(action.receipt[1]);
        } else normalizeReceipt(action.receipt);
    }
    if (Object.hasOwn(action, 'receipts')) {
        if (!Array.isArray(action.receipts)) throw new Uint64ValueError('Invalid grouped action receipts');
        for (const receipt of action.receipts) normalizeReceipt(receipt);
    }
    return action;
}

/** uint32 code/ABI counters, ordinals, legacy parent and contract fields are separate contracts. */
export function isActionSequenceField(path: string): boolean {
    return /^(?:global_sequence|receipts?(?:\[(?:0|[1-9][0-9]*)\])?\.(?:global_sequence|recv_sequence|auth_sequence(?:\[(?:0|[1-9][0-9]*)\])?\.sequence))$/.test(path);
}

function sequenceValues(value: unknown, parts: readonly string[]): unknown[] {
    if (parts.length === 0) return Array.isArray(value) ? value.flatMap(item => sequenceValues(item, [])) : [value];
    if (Array.isArray(value)) return value.flatMap(item => sequenceValues(item, parts));
    if (value === null || typeof value !== 'object') return [];
    const match = /^([^[]+)(?:\[(0|[1-9][0-9]*)\])?$/.exec(parts[0]);
    if (!match) return [];
    let next = (value as MetadataObject)[match[1]];
    if (match[2] !== undefined) next = Array.isArray(next) ? next[Number(match[2])] : undefined;
    return next === undefined ? [] : sequenceValues(next, parts.slice(1));
}

/** Metadata arrays use Elasticsearch's existential match / whole-document exclusion semantics. */
export function checkActionSequenceFilter(filter: RequestFilter, action: unknown): boolean {
    const operator = filter.operator ?? 'eq';
    if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(operator) || filter.asset) return false;
    try {
        const expected = compatibleUint64(filter.value);
        const values = sequenceValues(action, filter.field.split('.')).map(compatibleUint64);
        const compared = values.map(value => compareUint64(value, expected));
        if (operator === 'ne') return compared.every(order => order !== 0);
        return compared.some(order => {
            switch (operator) {
                case 'gt': return order > 0;
                case 'gte': return order >= 0;
                case 'lt': return order < 0;
                case 'lte': return order <= 0;
                default: return order === 0;
            }
        });
    } catch (error) {
        if (error instanceof Uint64ValueError) return false;
        throw error;
    }
}
