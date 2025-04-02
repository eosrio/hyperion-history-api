import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {getSkipLimit} from "../../v2-history/get_actions/functions.js";

async function getTableRows(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const {skip, limit} = getSkipLimit(request.query);
    const maxDocs = fastify.manager.config.api.limits.get_table_rows ?? 100;

    // Validate required parameters
    if (!query.contract) {
        throw new Error('Missing required parameter: contract must be specified');
    }

    if (!query.table) {
        throw new Error('Missing required parameter: table must be specified');
    }

    const response: any = {
        contract: query.contract,
        table: query.table,
        rows_count: 0,
        rows: []
    };

    // Ensure MongoDB connection is available
    if (!fastify.manager.conn.mongodb || !fastify.mongo.client) {
        throw new Error('MongoDB connection not available');
    }

    // Construct collection name by combining contract and table
    const collectionName = `${query.contract}-${query.table}`;
    const dbName = `${fastify.manager.conn.mongodb.database_prefix}_${fastify.manager.chain}`;
    const collection = fastify.mongo.client.db(dbName).collection(collectionName);

    // Build query based on parameters
    const mongoQuery: any = {};
    if (query.scope) {
        mongoQuery.scope = query.scope;
    }

    // Map user-friendly parameters to @-prefixed database fields
    if (query.primary_key) {
        mongoQuery['@pk'] = query.primary_key;
    }
    if (query.scope) {
        mongoQuery['@scope'] = query.scope;
    }
    if (query.block_id) {
        mongoQuery['@block_id'] = query.block_id;
    }
    if (query.block_num) {
        mongoQuery['@block_num'] = parseInt(query.block_num);
    }
    if (query.block_time) {
        mongoQuery['@block_time'] = query.block_time;
    }
    if (query.payer) {
        mongoQuery['@payer'] = query.payer;
    }

    // Process dynamic JSON filters
    if (query.filters) {
        try {
            const parsedFilters = JSON.parse(query.filters);

            // Process each filter key and handle date conversions
            Object.entries(parsedFilters).forEach(([key, value]) => {
                // Skip if the field is already set by standard parameters
                if (key in mongoQuery) return;

                // Check if the value is an object that might contain date comparison operators
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    // Common MongoDB comparison operators that might contain date strings
                    const dateOperators = ['$gt', '$gte', '$lt', '$lte', '$eq'];
                    const processedValue = { ...value };

                    // Check each potential date operator
                    dateOperators.forEach(op => {
                        if (op in processedValue) {
                            const dateValue = processedValue[op];

                            // Only process string values that might be dates
                            if (typeof dateValue === 'string') {
                                // Try to parse as a date
                                const parsedDate = new Date(dateValue);

                                // Check if this is a valid date (not Invalid Date)
                                if (!isNaN(parsedDate.getTime())) {
                                    // Replace string with actual Date object for MongoDB
                                    processedValue[op] = parsedDate.toISOString();
                                } else if (dateValue.match(/^\d{4}-\d{2}-\d{2}/) ||
                                          dateValue.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/) ||
                                          dateValue.includes('Z') ||
                                          dateValue.includes('+')) {
                                    // String looks like a date format but failed to parse
                                    throw new Error(`Invalid date format for ${key} ${op}: ${dateValue}`);
                                }
                                // If not a date format, leave as is (could be a string we want to compare)
                            }
                        }
                    });

                    mongoQuery[key] = processedValue;
                } else {
                    // Not a potential date comparison, use as is
                    mongoQuery[key] = value;
                }
            });

            console.log('Used filters (with date processing):', JSON.stringify(mongoQuery, (key, value) => {
                // Convert Date objects to ISO strings for logging
                if (value instanceof Date) {
                    return `Date(${value.toISOString()})`;
                }
                return value;
            }, 2));

        } catch (error:any) {
            throw new Error(`Filter processing error: ${error.message}`);
        }
    }

    console.log(mongoQuery);

    // Get count of matching documents
    response.rows_count = await collection.countDocuments(mongoQuery);

    // Apply pagination limits
    const finalLimit = Math.min(limit || 50, maxDocs);

    // Build sort options
    let sortOptions = {};
    if (query.sort_by) {
        // Determine sort direction (1 for ascending, -1 for descending)
        const sortDirection = query.sort_direction === 'desc' ? -1 : 1;
        sortOptions = { [query.sort_by]: sortDirection };

        // Include sort info in response
        response.sort_by = query.sort_by;
        response.sort_direction = query.sort_direction || 'asc';
    }

    // Get rows with sorting applied
    response.rows = await collection
        .find(mongoQuery, {projection: {_id: 0}})
        .sort(sortOptions)
        .skip(skip || 0)
        .limit(finalLimit)
        .toArray();
    return response;
}

export function getTableRowsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getTableRows, fastify, request, route));
    }
}
