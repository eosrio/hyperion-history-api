import {primaryTerms, terms} from "./definitions.js";

export function addSortedBy(query, queryBody, sort_direction) {
    if (query['sortedBy']) {
        const opts = query['sortedBy'].split(":");
        const sortedByObj = {};
        sortedByObj[opts[0]] = opts[1];
        queryBody['sort'] = sortedByObj;
    } else {
        queryBody['sort'] = {
            "global_sequence": sort_direction
        };
    }
}

export function processMultiVars(queryStruct, parts, field) {
    const must: any[] = [];
    const mustNot: any[] = [];

    parts.forEach(part => {
        if (part.startsWith("!")) {
            mustNot.push(part.replace("!", ""));
        } else {
            must.push(part);
        }
    });

    if (must.length > 1) {
        queryStruct.bool.must.push({
            bool: {
                should: must.map(elem => {
                    const _q = {};
                    _q[field] = elem;
                    return {term: _q}
                })
            }
        });
    } else if (must.length === 1) {
        const mustQuery = {};
        mustQuery[field] = must[0];
        queryStruct.bool.must.push({term: mustQuery});
    }

    if (mustNot.length > 1) {
        queryStruct.bool.must_not.push({
            bool: {
                should: mustNot.map(elem => {
                    const _q = {};
                    _q[field] = elem;
                    return {term: _q}
                })
            }
        });
    } else if (mustNot.length === 1) {
        const mustNotQuery = {};
        mustNotQuery[field] = mustNot[0].replace("!", "");
        queryStruct.bool.must_not.push({term: mustNotQuery});
    }
}

function addRangeQuery(queryStruct, prop, pkey, query) {
    const _termQuery = {};
    const parts = query[prop].split("-");
    _termQuery[pkey] = {
        "gte": parts[0],
        "lte": parts[1]
    };
    queryStruct.bool.must.push({range: _termQuery});
}

// A bound is a block number when it is a bare positive integer; any other value
// (ISO date string, etc.) is treated as a date/timestamp. Number() is strict where
// parseInt is not — Number("2026-01-01") is NaN — so a date without a 'T' is correctly
// classified as a date rather than as block 2026.
export function isBlockNumber(v: any): boolean {
    return Number.isInteger(Number(v)) && Number(v) > 0;
}

export function applyTimeFilter(query, queryStruct) {
    if (query['after'] || query['before']) {

        if (query['after']?.includes(' ')) {
            query['after'] = query['after'].replace(' ', 'T');
        }

        if (query['before']?.includes(' ')) {
            query['before'] = query['before'].replace(' ', 'T');
        }

        // Each bound is classified independently: bare positive integers filter on
        // block_num, anything else is treated as a date/timestamp filter on @timestamp.
        // Handling them separately lets the two bound types be mixed — e.g. a
        // block-number "after" together with an ISO-date "before" (previously a single
        // branch was chosen for both bounds, so a block number passed alongside a date
        // was fed to new Date(...) and threw "Invalid time value").
        const tsRange: any = {};
        const blockRange: any = {};

        if (query['after']) {
            if (isBlockNumber(query['after'])) {
                blockRange['gte'] = query['after'];
            } else {
                try {
                    tsRange['gte'] = new Date(query['after']).toISOString();
                } catch (e: any) {
                    badRequest(e.message + ' [after]');
                }
            }
        }

        if (query['before']) {
            if (isBlockNumber(query['before'])) {
                blockRange['lte'] = query['before'];
            } else {
                try {
                    tsRange['lte'] = new Date(query['before']).toISOString();
                } catch (e: any) {
                    badRequest(e.message + ' [before]');
                }
            }
        }

        if (Object.keys(tsRange).length > 0 || Object.keys(blockRange).length > 0) {
            if (!queryStruct.bool['filter']) {
                queryStruct.bool['filter'] = [];
            }
            if (Object.keys(tsRange).length > 0) {
                queryStruct.bool['filter'].push({range: {"@timestamp": tsRange}});
            }
            if (Object.keys(blockRange).length > 0) {
                queryStruct.bool['filter'].push({range: {block_num: blockRange}});
            }
        }
    }
}

export function applyGenericFilters(query, queryStruct, allowedExtraParams: Set<string>) {
    for (const prop in query) {
        if (Object.prototype.hasOwnProperty.call(query, prop)) {
            const pair = prop.split(".");
            if (pair.length > 1 || primaryTerms.includes(pair[0])) {
                let pkey;
                if (pair.length > 1 && allowedExtraParams) {
                    pkey = allowedExtraParams.has(pair[0]) ? "@" + prop : prop;
                } else {
                    pkey = prop;
                }
                if (query[prop].indexOf("-") !== -1) {
                    addRangeQuery(queryStruct, prop, pkey, query);
                } else {
                    const _qObj = {};
                    const parts = query[prop].split(",");
                    if (parts.length > 1) {
                        processMultiVars(queryStruct, parts, prop);
                    } else if (parts.length === 1) {

                        // @transfer.memo special case
                        if (pkey === '@transfer.memo') {
                            _qObj[pkey] = {
                                query: parts[0]
                            };

                            if (query.match_fuzziness) {
                                _qObj[pkey].fuzziness = query.match_fuzziness;
                            }

                            if (query.match_operator) {
                                _qObj[pkey].operator = query.match_operator;
                            }

                            // Keep the memo full-text match in scoring context: it is the only
                            // relevance-bearing clause, so an explicit sortedBy=_score (with
                            // fuzziness/operator) must still rank by it. It is selective and rare,
                            // so its scoring cost is negligible — unlike the high-cardinality
                            // keyword clauses moved to filter context.
                            queryStruct.bool.must.push({
                                match: _qObj
                            });
                        } else {
                            const andParts = parts[0].split(" ");
                            if (andParts.length > 1) {
                                andParts.forEach(value => {
                                    const _q = {};
                                    _q[pkey] = value;
                                    queryStruct.bool.must.push({term: _q});
                                });
                            } else {
                                if (parts[0].startsWith("!")) {
                                    _qObj[pkey] = parts[0].replace("!", "");
                                    queryStruct.bool.must_not.push({term: _qObj});
                                } else {
                                    _qObj[pkey] = parts[0];
                                    queryStruct.bool.must.push({term: _qObj});
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

export function makeShouldArray(query) {
    const should_array: any[] = [];
    for (const entry of terms) {
        const tObj = {term: {}};
        tObj.term[entry] = query.account;
        should_array.push(tObj);
    }
    return should_array;
}

export function applyCodeActionFilters(query, queryStruct) {
    let filterObj: any[] = [];
    if (query.filter) {
        for (const filter of query.filter.split(',')) {
            if (filter !== '*:*') {
                const _arr: any[] = [];
                const parts = filter.split(':');
                if (parts.length === 2) {
                    const [code, method] = parts;
                    if (code && code !== "*") {
                        _arr.push({'term': {'act.account': code}});
                    }
                    if (method && method !== "*") {
                        _arr.push({'term': {'act.name': method}});
                    }
                }
                if (_arr.length > 0) {
                    filterObj.push({bool: {must: _arr}});
                }
            }
        }
        if (filterObj.length > 0) {
            queryStruct.bool['should'] = filterObj;
            queryStruct.bool['minimum_should_match'] = 1;
        }
    }
}

function badRequest(message: string): never {
    const err: any = new Error(message);
    err.statusCode = 400;
    throw err;
}

export function getSkipLimit(query: any, max?: number): { skip: number, limit: number } {
    let skip: number;
    let limit: number;

    if (query.skip) {
        skip = parseInt(query.skip, 10);
        if (skip < 0) {
            badRequest('invalid skip parameter');
        }
        if (skip > 10000) {
            badRequest('skip is above maximum internal limit: 10000. please limit your search scope or use pagination with before/after parameters');
        }
    } else {
        skip = 0;
    }

    if (query.limit) {
        limit = parseInt(query.limit, 10);
        if (limit < 1) {
            badRequest('invalid limit parameter');
        } else if (limit > (max ?? 10000)) {
            badRequest(`limit too big, maximum: ${max}`);
        }
    } else {
        limit = 0;
    }

    return {skip, limit};
}

// A range (or single positive value) on a monotonic field bounds an asc scan as
// effectively as after/before. global_sequence is the default sort field, so a
// global_sequence range constrains the candidate set directly; block_num ranges
// likewise. Accepts "<from>-<to>" ranges and bare positive values. A bare 0 and
// non-numeric input are rejected; in a range only the *upper* bound must be
// positive (a 0 lower bound is a valid "from the start" bound). Digit-string
// checks avoid Number() precision loss on uint64. Array inputs (a query param
// repeated in the URL) are rejected here and would also break downstream filter
// building, so they fail fast as unbounded rather than 500 later.
function hasMonotonicBound(query): boolean {
    const isBoundValue = (v) => {
        if (typeof v !== 'string' && typeof v !== 'number') {
            return false;
        }
        const s = String(v).trim();
        if (s === '') {
            return false;
        }
        const parts = s.split('-');
        if (parts.length === 2) {
            // "<from>-<to>" range — upper bound must be a positive integer
            return /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && !/^0+$/.test(parts[1]);
        }
        // single positive value (matches at most a handful of docs)
        return /^\d+$/.test(s) && !/^0+$/.test(s);
    };
    return isBoundValue(query.global_sequence) || isBoundValue(query.block_num);
}

export function getSortDir(query, maxAscWindowDays = 90, requireBoundedAsc = true) {
    let sort_direction = 'desc';
    if (query.sort) {
        if (query.sort === 'asc' || query.sort === '1') {
            if (requireBoundedAsc) {
                // sort=asc requires a valid, recent time range to prevent full-index reverse scans
                const after = query.after;
                const before = query.before;
                const isValidBound = (v) => (typeof v === 'string' || typeof v === 'number') && v && (!isNaN(new Date(v).getTime()) || (Number.isInteger(Number(v)) && Number(v) > 0));
                // A global_sequence/block_num range also bounds the scan — global_sequence is the
                // default sort field, so such a range constrains the candidate set directly.
                if (!isValidBound(after) && !isValidBound(before) && !hasMonotonicBound(query)) {
                    badRequest('sort=asc requires a valid "after"/"before" (ISO date or block number) or a global_sequence/block_num range or value to bound the search');
                }
                // Apply the recency window to a *date* "after" bound. Block-number bounds are
                // exempt — they bound the reverse scan just as well. Classified the same way
                // as applyTimeFilter so a date without a 'T' (e.g. "2026-01-01", or "0" which
                // parses to year 2000) cannot slip past the window check.
                if (after && !isBlockNumber(after)) {
                    const afterDate = new Date(after);
                    if (!isNaN(afterDate.getTime())) {
                        const maxAge = Date.now() - (maxAscWindowDays * 86400000);
                        if (afterDate.getTime() < maxAge) {
                            badRequest(`sort=asc "after" date must be within the last ${maxAscWindowDays} days — use block numbers for "after"/"before" to query older ranges`);
                        }
                    }
                }
            }
            sort_direction = 'asc';
        } else if (query.sort === 'desc' || query.sort === '-1') {
            sort_direction = 'desc'
        } else {
            badRequest('invalid sort direction');
        }
    }
    return sort_direction;
}

export function applyAccountFilters(query, queryStruct) {
    if (query.account) {
        // Scoring (must) context, NOT filter. Filter context routes this clause through ES's query
        // cache; for a low-selectivity account like eosio.token over large/old (cold-tier) segments,
        // *building* the cached bitset (full per-segment bulkScorer enumeration) costs far more than
        // the BM25 it would save and defeats index-sort early termination. Observed dominating
        // node-6 hot_threads (IndicesQueryCache.bulkScorer). See memory: filter-context-query-cache-tradeoff.
        queryStruct.bool.must.push({"bool": {should: makeShouldArray(query)}});
    }
}
