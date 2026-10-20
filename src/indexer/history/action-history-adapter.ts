import {Client, errors, estypes} from '@elastic/elasticsearch';
import {
    ActionHistoryCoverageAuthority, ActionHistoryCoverageLease, ActionHistoryIndexIdentity,
    ActionHistoryUnavailableError, assertCompleteActionHistorySearch, unavailableActionHistoryCoverage
} from './action-history-coverage.js';
import {ACTION_SEQUENCE_NAMESPACE, restoreActionSequenceStorage} from './action-sequence-storage.js';
import {actionSequenceSort, compileActionSequenceQuery, queryRequiresUnsafeRoot, validateActionSequenceSortCursor} from './action-sequence-query-plan.js';
import {projectActionSource} from './action-source-projection.js';

type Query = estypes.QueryDslQueryContainer;
export type ActionHistorySearchRequest = Pick<estypes.SearchRequest,
    'query' | 'sort' | 'size' | 'from' | 'search_after' | '_source' | 'track_total_hits' | 'timeout' | 'aggs' | 'aggregations'>;
const searchKeys = new Set(['query', 'sort', 'size', 'from', 'search_after', '_source', 'track_total_hits', 'timeout', 'aggs', 'aggregations']);
const safeMaximum = String(Number.MAX_SAFE_INTEGER);
const namespaceVersion = `${ACTION_SEQUENCE_NAMESPACE}.version`;
const legacy = {bool: {must_not: [{exists: {field: namespaceVersion}}],
    filter: [{range: {global_sequence: {gte: '1', lte: safeMaximum}}}]}} satisfies Query;
const exact = {term: {[namespaceVersion]: 1}} satisfies Query;
const fields = ['global_sequence', 'receipts.global_sequence', 'receipts.recv_sequence', 'receipts.auth_sequence.sequence'];

function unavailable(message: string): never {throw new ActionHistoryUnavailableError(message);}

function active(signal: AbortSignal): void {
    if (signal.aborted) unavailable('Elasticsearch action history search was cancelled');
}

function sameIndices(left: readonly ActionHistoryIndexIdentity[], right: readonly ActionHistoryIndexIdentity[]): boolean {
    return left.length === right.length && left.every((item, index) => item.name === right[index].name && item.uuid === right[index].uuid);
}

function qualifiedLease(lease: ActionHistoryCoverageLease, indices: readonly ActionHistoryIndexIdentity[]): void {
    if (!lease || typeof lease.generation !== 'string' || !lease.generation || typeof lease.source !== 'string' || !lease.source ||
        !Array.isArray(lease.indices) || !sameIndices(indices, lease.indices) ||
        typeof lease.assertComplete !== 'function' || typeof lease.assertCurrent !== 'function' || typeof lease.release !== 'function') {
        unavailable('Action history coverage lease does not identify this concrete index generation');
    }
}

function membership(query: Query): Query {
    return {bool: {should: [
        {bool: {filter: [exact], must: [compileActionSequenceQuery(query, 'exact')]}},
        {bool: {filter: [legacy], must: [compileActionSequenceQuery(query, 'legacy')]}}
    ], minimum_should_match: 1}};
}

const metricAggregations = new Set(['stats', 'extended_stats', 'min', 'max', 'avg', 'sum', 'value_count', 'cardinality', 'percentiles', 'percentile_ranks']);
function validateAggregations(value: unknown): void {
    if (value === undefined) return;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable('Invalid action history aggregations');
    for (const aggregation of Object.values(value)) {
        if (aggregation === null || typeof aggregation !== 'object' || Array.isArray(aggregation)) unavailable('Invalid action history aggregation');
        const operators = Object.entries(aggregation).filter(([key]) => key !== 'meta');
        if (operators.length !== 1 || !metricAggregations.has(operators[0][0])) {
            // In particular, global/filter/filters can escape compiled membership.
            unavailable('Action history aggregation requires a qualified logical adapter');
        }
        const operand = operators[0][1];
        if (!operand || typeof operand !== 'object' || Array.isArray(operand) ||
            !('field' in operand) || typeof operand.field !== 'string' || 'script' in operand) {
            unavailable('Action history metrics require an explicit qualified non-sequence field');
        }
        // Reuse the planner's reserved-field and wildcard recognizer instead of
        // maintaining an incomplete second list of physical metadata names.
        const translated = compileActionSequenceQuery({exists: {field: operand.field}}, 'exact');
        if (translated.exists?.field !== operand.field) unavailable('Exact sequence metadata aggregations are not qualified');
    }
}

function total(result: estypes.SearchResponse): number {
    const value = result.hits.total;
    if (!value || typeof value === 'number' || value.relation !== 'eq' || !Number.isSafeInteger(value.value) || value.value < 0) {
        unavailable('Exact action history count was not returned');
    }
    return value.value;
}

/**
 * Gated production seam, not installed into public routes yet. A durable coverage
 * authority and all direct-reader migrations are required before host activation.
 * The default authority refuses; no surviving-row count can silently certify it.
 */
export class ActionHistoryAdapter {
    constructor(
        private readonly client: Client,
        private readonly chain: string,
        private readonly coverage: ActionHistoryCoverageAuthority = unavailableActionHistoryCoverage
    ) {
        if (!chain || /[*,\s]/.test(chain)) throw new Error('Expected one configured action-history chain');
    }

    private async identities(index: string | string[], signal: AbortSignal): Promise<ActionHistoryIndexIdentity[]> {
        active(signal);
        const resolved = await this.client.indices.resolveIndex({name: index, expand_wildcards: 'open'}, {signal});
        if (resolved.data_streams?.length) unavailable('Action history data-stream routing is not qualified');
        const names = [...new Set([...(resolved.indices ?? []).map(entry => entry.name),
            ...(resolved.aliases ?? []).flatMap(alias => alias.indices)])].sort();
        if (!names.length || names.some(name => typeof name !== 'string' || !name.startsWith(`${this.chain}-action-`))) {
            unavailable('Action history could not resolve concrete owned index identities');
        }
        if (resolved.aliases?.length) {
            const aliases = await this.client.indices.getAlias({name: resolved.aliases.map(alias => alias.name)}, {signal});
            for (const entry of Object.values(aliases)) for (const alias of Object.values(entry.aliases)) {
                if (alias.filter || alias.routing || alias.index_routing || alias.search_routing) {
                    unavailable('Filtered or routed action-history aliases require a qualified coverage scope');
                }
            }
            for (const selected of resolved.aliases) {
                const actual = Object.entries(aliases).filter(([, value]) => Object.hasOwn(value.aliases, selected.name)).map(([name]) => name).sort();
                if (JSON.stringify(actual) !== JSON.stringify([...selected.indices].sort())) {
                    unavailable('Action history alias targets changed during resolution');
                }
            }
        }
        // Flat settings use the literal key "index.uuid". Filtering through a
        // fictitious nested index.uuid path silently removes every identity.
        const settings = await this.client.indices.getSettings({index: names, flat_settings: true, filter_path: '*.settings'}, {signal});
        const identities = Object.entries(settings).map(([name, value]) => ({name, uuid: value.settings?.['index.uuid']}));
        if (identities.length !== names.length || identities.some(item => !names.includes(item.name) ||
            typeof item.uuid !== 'string' || item.uuid.length === 0)) {
            unavailable('Action history could not resolve concrete owned index identities');
        }
        return identities.sort((left, right) => left.name.localeCompare(right.name)) as ActionHistoryIndexIdentity[];
    }

    async open(index: string | string[], options: {signal?: AbortSignal} = {}): Promise<ActionHistoryReadContext> {
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal?.addEventListener('abort', abort, {once: true});
        if (options.signal?.aborted) abort();
        let pitId: string | undefined, lease: ActionHistoryCoverageLease | undefined;
        try {
            const indices = await this.identities(index, controller.signal);
            const targets = indices.map(entry => entry.name);
            const opened = await this.client.openPointInTime({index: targets, keep_alive: '1m', allow_partial_search_results: false}, {signal: controller.signal});
            pitId = opened.id;
            if (!pitId) unavailable('Elasticsearch did not return an action history PIT');
            assertCompleteActionHistorySearch({timed_out: false, _shards: opened._shards});
            const current = await this.identities(targets, controller.signal);
            if (!sameIndices(indices, current)) unavailable('Action history index identities changed while opening the PIT');
            lease = await this.coverage.acquire({pitId, indices}, controller.signal);
            qualifiedLease(lease, indices);
            await lease.assertCurrent(controller.signal);
            active(controller.signal);
            return new ActionHistoryReadContext(this.client, pitId, lease, controller,
                () => options.signal?.removeEventListener('abort', abort));
        } catch (error) {
            options.signal?.removeEventListener('abort', abort);
            const cleanup = await Promise.allSettled([
                ...(pitId ? [this.client.closePointInTime({id: pitId})] : []),
                ...(lease && typeof lease.release === 'function' ? [lease.release()] : [])
            ]);
            if (cleanup.some(result => result.status === 'rejected')) unavailable('Action history open failed and its resource cleanup failed');
            throw requestError(error, controller.signal);
        }
    }

    async search<T = Record<string, unknown>>(index: string | string[], params: ActionHistorySearchRequest,
        options: {signal?: AbortSignal} = {}): Promise<estypes.SearchResponse<T>> {
        const context = await this.open(index, options);
        try {return await context.search<T>(params);} finally {await context.close();}
    }
}

function requestError(error: unknown, signal: AbortSignal): unknown {
    if (signal.aborted || error instanceof errors.RequestAbortedError) {
        return new ActionHistoryUnavailableError('Elasticsearch action history search was cancelled');
    }
    if (error instanceof errors.TimeoutError) return Object.assign(new Error('Elasticsearch action history request timed out'), {statusCode: 504});
    if (error instanceof errors.ResponseError) {
        return Object.assign(new ActionHistoryUnavailableError('Elasticsearch action history query capability is unavailable'), {cause: error});
    }
    return error;
}

/** One PIT, one coverage lease and one ordered request at a time; caller closes in finally. */
export class ActionHistoryReadContext {
    private closing?: Promise<void>;
    private pending?: Promise<unknown>;

    constructor(
        private readonly client: Client,
        private pitId: string,
        private readonly lease: ActionHistoryCoverageLease,
        private readonly controller: AbortController,
        private readonly detach: () => void
    ) {}

    private async native<T = Record<string, unknown>>(params: estypes.SearchRequest): Promise<estypes.SearchResponse<T>> {
        active(this.controller.signal);
        const result = await this.client.search<T>({...params, pit: {id: this.pitId, keep_alive: '1m'},
            allow_partial_search_results: false}, {signal: this.controller.signal});
        // Even a failed/partial response can rotate the ID. Always own its latest ID.
        if (result.pit_id) this.pitId = result.pit_id;
        assertCompleteActionHistorySearch(result);
        active(this.controller.signal);
        return result;
    }

    private async assertVisibleCoverage(query: Query): Promise<void> {
        await this.lease.assertComplete(query, this.controller.signal);
        await this.lease.assertCurrent(this.controller.signal);
        active(this.controller.signal);
        // Never apply a contract/time predicate to this ambiguity probe. A lost
        // row from that contract is precisely what a surviving-row probe misses.
        const unknownRoot: Query = {bool: {must_not: [{exists: {field: namespaceVersion}}], should: [
            {range: {global_sequence: {gt: safeMaximum}}}, {range: {global_sequence: {lte: '0'}}},
            {bool: {must_not: [{exists: {field: 'global_sequence'}}]}}
        ], minimum_should_match: 1}};
        if (queryRequiresUnsafeRoot(query)) {
            const result = await this.native({size: 0, _source: false, query: unknownRoot, track_total_hits: true});
            if (total(result) !== 0) unavailable('Exact action history coverage is incomplete in a physical source partition');
        }
        const invalidExact: Query = {bool: {should: [
            {bool: {filter: [{exists: {field: namespaceVersion}}], must_not: [exact]}},
            {bool: {filter: [exact], should: [
                {bool: {must_not: [{exists: {field: `${ACTION_SEQUENCE_NAMESPACE}.global.value`}}]}},
                {bool: {must_not: [{exists: {field: `${ACTION_SEQUENCE_NAMESPACE}.global.key`}}]}}
            ], minimum_should_match: 1}}
        ], minimum_should_match: 1}};
        const integrity = await this.native({size: 0, _source: false, query: invalidExact, track_total_hits: true});
        if (total(integrity) !== 0) unavailable('Exact action history namespace is incomplete or unsupported');
        // Safe-root loss is disjoint from unsafe-root collisions only when the
        // authority qualified that producer. Other legacy metadata still needs
        // its own domain check; safe root alone never proves safe receipt leaves.
        const unsafeMetadata: Query[] = fields.slice(1).map(field => ({range: {[field]: {gt: safeMaximum}}}));
        for (const field of ['code_sequence', 'abi_sequence']) unsafeMetadata.push({range: {[field]: {gt: '2147483647'}}});
        const result = await this.native({size: 0, _source: false, query: {bool: {filter: [legacy],
            should: unsafeMetadata, minimum_should_match: 1}}, track_total_hits: true});
        if (total(result) !== 0) unavailable('Exact legacy receipt or authorization sequence coverage is incomplete');
    }

    async search<T = Record<string, unknown>>(params: ActionHistorySearchRequest): Promise<estypes.SearchResponse<T>> {
        if (this.closing || this.pending) unavailable('Action history PIT is closed or already processing a page');
        const work = this.searchPage<T>(params);
        this.pending = work;
        try {return await work;} catch (error) {throw requestError(error, this.controller.signal);} finally {this.pending = undefined;}
    }

    private async searchPage<T>(params: ActionHistorySearchRequest): Promise<estypes.SearchResponse<T>> {
        active(this.controller.signal);
        if (Object.keys(params).some(key => !searchKeys.has(key))) unavailable('Unsupported action history search option');
        if (params.aggs !== undefined && params.aggregations !== undefined) unavailable('Use one logical aggregation container');
        validateAggregations(params.aggs ?? params.aggregations);
        const query = params.query ?? {match_all: {}};
        const logicalSort = params.sort ?? (params.size === 0 ? undefined : {global_sequence: 'desc'});
        if (params.search_after !== undefined) validateActionSequenceSortCursor(logicalSort, params.search_after);
        const nativeQuery = membership(query);
        const nativeSort = actionSequenceSort(logicalSort, 'mixed');
        // Validate the projection even when a page has no hits.
        projectActionSource({}, params._source);
        await this.assertVisibleCoverage(query);
        const result = await this.native<T>({...params, query: nativeQuery, sort: nativeSort,
            _source: params._source === false ? false : true,
            ...(params._source === false ? {} : {fields: [{field: namespaceVersion}]})});
        for (const hit of result.hits.hits) {
            if (hit.sort) validateActionSequenceSortCursor(logicalSort, hit.sort);
            if (hit._source !== undefined) {
                try {
                    const source = hit._source as Record<string, unknown>;
                    const indexed = hit.fields?.[namespaceVersion];
                    if ((Object.hasOwn(source, ACTION_SEQUENCE_NAMESPACE) &&
                        (!Array.isArray(indexed) || indexed.length !== 1 || indexed[0] !== 1)) ||
                        (!Object.hasOwn(source, ACTION_SEQUENCE_NAMESPACE) && indexed !== undefined)) {
                        unavailable('Stored action source and indexed sequence namespace disagree');
                    }
                    const logical = restoreActionSequenceStorage(source);
                    if (typeof hit._id !== 'string' || hit._id !== logical.global_sequence) {
                        unavailable('Action document ID and exact source root disagree');
                    }
                    hit._source = projectActionSource(logical, params._source) as T;
                    delete hit.fields;
                } catch (error) {
                    if (error instanceof ActionHistoryUnavailableError) throw error;
                    unavailable('Exact action history source metadata could not be restored');
                }
            }
        }
        await this.lease.assertCurrent(this.controller.signal);
        active(this.controller.signal);
        return result;
    }

    async count(query: Query = {match_all: {}}): Promise<number> {
        return total(await this.search({query, size: 0, _source: false, track_total_hits: true}));
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.controller.abort();
        this.closing = (async () => {
            if (this.pending) await this.pending.catch(() => {});
            this.detach();
            const cleanup = await Promise.allSettled([
                this.client.closePointInTime({id: this.pitId}).then(receipt => {
                    if (receipt.succeeded !== true) unavailable('Elasticsearch did not acknowledge action history PIT cleanup');
                }), this.lease.release()
            ]);
            if (cleanup.some(result => result.status === 'rejected')) unavailable('Action history PIT or coverage lease cleanup failed');
        })();
        return this.closing;
    }
}
