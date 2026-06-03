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
        (queryStruct.bool.filter ??= []).push({
            bool: {
                should: must.map(elem => {
                    const _q = {};
                    _q[field] = elem;
                    return {term: _q}
                }),
                minimum_should_match: 1
            }
        });
    } else if (must.length === 1) {
        const mustQuery = {};
        mustQuery[field] = must[0];
        (queryStruct.bool.filter ??= []).push({term: mustQuery});
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
    (queryStruct.bool.filter ??= []).push({range: _termQuery});
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

                            (queryStruct.bool.filter ??= []).push({
                                match: _qObj
                            });
                        } else {
                            const andParts = parts[0].split(" ");
                            if (andParts.length > 1) {
                                andParts.forEach(value => {
                                    const _q = {};
                                    _q[pkey] = value;
                                    (queryStruct.bool.filter ??= []).push({term: _q});
                                });
                            } else {
                                if (parts[0].startsWith("!")) {
                                    _qObj[pkey] = parts[0].replace("!", "");
                                    queryStruct.bool.must_not.push({term: _qObj});
                                } else {
                                    _qObj[pkey] = parts[0];
                                    (queryStruct.bool.filter ??= []).push({term: _qObj});
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
            // Code:name filter in filter context (was a scoring root-level should+msm). Semantics
            // are identical — "match >= 1 of the code:name pairs" — minus the wasted scoring.
            (queryStruct.bool.filter ??= []).push({bool: {should: filterObj, minimum_should_match: 1}});
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

export function getSortDir(query, maxAscWindowDays = 90) {
    let sort_direction = 'desc';
    if (query.sort) {
        if (query.sort === 'asc' || query.sort === '1') {
            // sort=asc requires a valid, recent time range to prevent full-index reverse scans
            const after = query.after;
            const before = query.before;
            const isValidBound = (v) => v && (!isNaN(new Date(v).getTime()) || (Number.isInteger(Number(v)) && Number(v) > 0));
            if (!isValidBound(after) && !isValidBound(before)) {
                badRequest('sort=asc requires a valid "after" or "before" (ISO date or block number) to bound the search');
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
        // Filter context: the account match is a pure include and results are sorted by
        // global_sequence (never _score), so scoring this should-clause across millions of docs
        // is wasted work. filter context skips scoring and is cacheable. minimum_should_match is
        // explicit (a should-only bool defaults to 1, but filter context makes it worth stating).
        (queryStruct.bool.filter ??= []).push({bool: {should: makeShouldArray(query), minimum_should_match: 1}});
    }
}
