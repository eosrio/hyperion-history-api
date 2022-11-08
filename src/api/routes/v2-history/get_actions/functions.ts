import {primaryTerms, terms} from "./definitions.js";
import {estypes} from "@elastic/elasticsearch";
import {pushBoolElement} from "../../../helpers/functions.js";

export function addSortedBy(query: any, queryBody: estypes.SearchRequest, sort_direction: estypes.SortOrder) {
    if (query['sortedBy']) {
        const opts = query['sortedBy'].split(":");
        const sortedByObj: Record<string, any> = {};
        sortedByObj[opts[0]] = opts[1];
        queryBody.sort = sortedByObj;
    } else {
        queryBody.sort = {
            "global_sequence": sort_direction
        };
    }
}

export function processMultiVars(
    queryStruct: estypes.QueryDslQueryContainer,
    parts: string[],
    field: string
) {
    const must: any[] = [];
    const mustNot: any[] = [];

    parts.forEach((part: string) => {
        if (part.startsWith("!")) {
            mustNot.push(part.replace("!", ""));
        } else {
            must.push(part);
        }
    });

    if (must.length > 1) {
        pushBoolElement(queryStruct, 'must', {
            bool: {
                should: must.map(elem => {
                    const _q: Record<string, any> = {};
                    _q[field] = elem;
                    return {term: _q}
                })
            }
        });
    } else if (must.length === 1) {
        const mustQuery: Record<string, any> = {};
        mustQuery[field] = must[0];
        pushBoolElement(queryStruct, 'must', {term: mustQuery});
    }

    if (mustNot.length > 1) {
        pushBoolElement(queryStruct, 'must_not', {
            bool: {
                should: mustNot.map(elem => {
                    const _q: Record<string, any> = {};
                    _q[field] = elem;
                    return {term: _q}
                })
            }
        });
    } else if (mustNot.length === 1) {
        const mustNotQuery: Record<string, any> = {};
        mustNotQuery[field] = mustNot[0].replace("!", "");
        pushBoolElement(queryStruct, 'must_not', {term: mustNotQuery});
    }
}

function addRangeQuery(
    queryStruct: estypes.QueryDslQueryContainer,
    prop: string,
    pkey: string,
    query: Record<string, any>
) {
    const _termQuery: Record<string, any> = {};
    const parts = query[prop].split("-");
    _termQuery[pkey] = {
        "gte": parts[0],
        "lte": parts[1]
    };
    pushBoolElement(queryStruct, "must", {range: _termQuery});
}

export function applyTimeFilter(query: Record<string, any>, queryStruct: estypes.QueryDslQueryContainer) {
    if (query['after'] || query['before']) {
        let _lte = "now";
        let _gte = "0";
        if (query['before']) {
            try {
                _lte = new Date(query['before']).toISOString();
            } catch (e: any) {
                throw new Error(e.message + ' [before]');
            }
        }
        if (query['after']) {
            try {
                _gte = new Date(query['after']).toISOString();
            } catch (e: any) {
                throw new Error(e.message + ' [after]');
            }
        }
        pushBoolElement(queryStruct, "filter", {range: {"@timestamp": {gte: _gte, lte: _lte}}});
    }
}

export function applyGenericFilters(
    query: Record<string, any>,
    queryStruct: estypes.QueryDslQueryContainer,
    allowedExtraParams: Set<string>
) {
    for (const prop in query) {
        if (Object.prototype.hasOwnProperty.call(query, prop)) {
            const pair = prop.split(".");
            if (pair.length > 1 || primaryTerms.includes(pair[0])) {
                let pkey: string;
                if (pair.length > 1 && allowedExtraParams) {
                    pkey = allowedExtraParams.has(pair[0]) ? "@" + prop : prop;
                } else {
                    pkey = prop;
                }
                if (query[prop].indexOf("-") !== -1) {
                    addRangeQuery(queryStruct, prop, pkey, query);
                } else {
                    const _qObj: Record<string, any> = {};
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
                            pushBoolElement(queryStruct, "must", {match: _qObj});
                        } else {
                            const andParts = parts[0].split(" ");
                            if (andParts.length > 1) {
                                andParts.forEach((value: string) => {
                                    const _q: Record<string, any> = {};
                                    _q[pkey] = value;
                                    pushBoolElement(queryStruct, "must", {term: _q});
                                });
                            } else {
                                if (parts[0].startsWith("!")) {
                                    _qObj[pkey] = parts[0].replace("!", "");
                                    pushBoolElement(queryStruct, "must_not", {term: _qObj});
                                } else {
                                    _qObj[pkey] = parts[0];
                                    pushBoolElement(queryStruct, "must", {term: _qObj});
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

export function makeShouldArray(query: Record<string, any>) {
    const should_array: any[] = [];
    for (const entry of terms) {
        const tObj: { term: Record<string, any> } = {term: {}};
        tObj.term[entry] = query.account;
        should_array.push(tObj);
    }
    return should_array;
}

export function applyCodeActionFilters(query: Record<string, any>, queryStruct: estypes.QueryDslQueryContainer) {
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
        if (queryStruct.bool && filterObj.length > 0) {
            queryStruct.bool['should'] = filterObj;
            queryStruct.bool['minimum_should_match'] = 1;
        }
    }
}

export function getSkipLimit(query: Record<string, any>, max?: number) {
    let skip, limit;
    skip = parseInt(query.skip, 10);
    if (skip < 0) {
        throw new Error('invalid skip parameter');
    }
    limit = parseInt(query.limit, 10);
    if (limit < 1) {
        throw new Error('invalid limit parameter');
    } else if (max && limit > max) {
        throw new Error(`limit too big, maximum: ${max}`);
    }
    return {skip, limit};
}

export function getSortDir(query: Record<string, any>): estypes.SortOrder {
    let sort_direction: estypes.SortOrder = 'desc';
    if (query.sort) {
        if (query.sort === 'asc' || query.sort === '1') {
            sort_direction = 'asc';
        } else if (query.sort === 'desc' || query.sort === '-1') {
            sort_direction = 'desc'
        } else {
            throw new Error('invalid sort direction');
        }
    }
    return sort_direction;
}

export function applyAccountFilters(query: Record<string, any>, queryStruct: estypes.QueryDslQueryContainer) {
    pushBoolElement(queryStruct, "must", {"bool": {should: makeShouldArray(query)}})
}
