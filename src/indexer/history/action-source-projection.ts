import type {estypes} from '@elastic/elasticsearch';
import {ActionHistoryUnavailableError} from './action-history-coverage.js';

type Source = Record<string, unknown>;
const absent = Symbol('absent');

function patterns(input: unknown): RegExp[] {
    const values = typeof input === 'string' ? input.split(',') : input;
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
        throw new ActionHistoryUnavailableError('Unsupported action source projection');
    }
    return values.map(value => new RegExp('^' + value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
}

/** Restore the complete metadata first, then apply the logical source filter. */
export function projectActionSource(source: Source, filter: estypes.SearchRequest['_source']): Source | undefined {
    if (filter === false) return undefined;
    if (filter === undefined || filter === true) return source;
    let includes: RegExp[], excludes: RegExp[];
    if (typeof filter === 'string' || Array.isArray(filter)) {
        includes = patterns(filter);
        excludes = [];
    } else {
        if (Object.keys(filter).some(key => !['includes', 'excludes'].includes(key))) {
            throw new ActionHistoryUnavailableError('Unsupported action source projection option');
        }
        includes = patterns(filter.includes);
        excludes = patterns(filter.excludes);
    }
    function visit(value: unknown, path: string, inherited: boolean): unknown | typeof absent {
        if (path && excludes.some(pattern => pattern.test(path))) return absent;
        const selected = inherited || includes.length === 0 || includes.some(pattern => pattern.test(path));
        if (Array.isArray(value)) {
            const result = value.map(item => visit(item, path, selected)).filter(item => item !== absent);
            return result.length || selected ? result : absent;
        }
        if (value !== null && typeof value === 'object') {
            const entries = Object.entries(value).map(([key, item]) => [key, visit(item, path ? `${path}.${key}` : key, selected)] as const)
                .filter(([, item]) => item !== absent);
            return entries.length || selected ? Object.fromEntries(entries) : absent;
        }
        return selected ? value : absent;
    }
    const result = visit(source, '', false);
    return result === absent ? {} : result as Source;
}
