import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timedQuery } from "../../../helpers/functions.js";
import { getSkipLimit } from "../../v2-history/get_actions/functions.js";

async function getTableRows(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const { skip, limit } = getSkipLimit(request.query);
    const maxDocs = fastify.manager.config.api.limits.get_table_rows ?? 100;

    // Validate required parameters
    if (!query.contract) {
        throw new Error('Missing required parameter: contract must be specified');
    }

    if (!query.table) {
        throw new Error('Missing required parameter: table must be specified');
    }

    // Ensure MongoDB connection is available
    if (!fastify.manager.conn.mongodb || !fastify.mongo.client) {
        throw new Error('MongoDB connection not available');
    }

    // Construct collection name by combining contract and table
    const collectionName = `${query.contract}-${query.table}`;
    const dbName = `${fastify.manager.conn.mongodb.database_prefix}_${fastify.manager.chain}`;
    const db = fastify.mongo.client.db(dbName);

    // Check if the collection exists
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length === 0) {
        throw new Error(`Collection ${collectionName} does not exist. This contract-table pair is not indexed in this Hyperion instance. Check on v1/chain/get_table_rows?code=${query.contract}&table=${query.table}&scope=YOUR_SCOPE`);
    }

    const collection = db.collection(collectionName);

    const response: any = {
        contract: query.contract,
        table: query.table,
        rows_count: 0,
        rows: []
    };

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

        } catch (error: any) {
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
    let sortField = query.sort_by;
    if (sortField) {
        const sortDirection = query.sort_direction === 'desc' ? -1 : 1;
        sortOptions = { [sortField]: sortDirection };
    }

    // Get rows with sorting applied (or not, if no sort specified)
    let rows;
    try {
        rows = await collection
            .find(mongoQuery, { projection: { _id: 0 } })
            .sort(sortOptions)
            .skip(skip || 0)
            .limit(finalLimit)
            .toArray();

        // Verificar se o campo de ordenação existe nos resultados
        if (sortField && rows.length > 0 && !(sortField in rows[0])) {
            throw new Error(`Sort field '${sortField}' does not exist in the collection.`);
        }
    } catch (error) {
        // Se ocorrer qualquer erro durante a consulta ou verificação do campo
        if (sortField) {
            // Se havia um campo de ordenação especificado, assumimos que o erro está relacionado a ele
            throw new Error(`Error sorting by '${sortField}'. The field may not exist or there might be an issue with the sort operation.`);
        }
        // Se não havia campo de ordenação, repassamos o erro original
        throw error;
    }

    response.rows_count = await collection.countDocuments(mongoQuery);
    response.rows = rows;

    if (sortField) {
        response.sort_by = sortField;
        response.sort_direction = query.sort_direction || 'asc';
    }

    return response;
}


export function getTableRowsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const result = await timedQuery(getTableRows, fastify, request, route);
            reply.send(result);
        } catch (error: any) {
            // Check if the error is about the non-existent collection
            if (error.message.includes("Collection") && error.message.includes("does not exist")) {
                reply.status(404).send({
                    error: "Not Found",
                    message: error.message,
                    statusCode: 404
                });
            } else {
                // For other errors, you might want to send a 500 Internal Server Error
                reply.status(500).send({
                    error: "Internal Server Error",
                    message: error.message,
                    statusCode: 500
                });
            }
        }
    }
}