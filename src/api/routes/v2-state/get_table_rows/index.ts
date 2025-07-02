import {FastifyInstance} from "fastify";
import {getTableRowsHandler} from "./get_table_rows.js";
import {addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get table rows from contract table',
        summary: 'get table rows',
        tags: ['state'],
        querystring: extendQueryStringSchema({
            "contract": {
                description: 'contract name',
                type: 'string',
                minLength: 1,
            },
            "table": {
                description: 'table name',
                type: 'string',
                minLength: 1,
            },
            "primary_key": {
                description: 'filter by primary key',
                type: 'string'
            },
            "scope": {
                description: 'filter by scope',
                type: 'string'
            },
            "block_id": {
                description: 'filter by block ID',
                type: 'string'
            },
            "block_num": {
                description: 'filter by block number',
                type: 'integer'
            },
            "block_time": {
                description: 'filter by block time',
                type: 'string'
            },
            "payer": {
                description: 'filter by payer account',
                type: 'string'
            },
            "filters": {
                description: 'JSON string containing dynamic filters to apply to table rows. ' +
                  'Example: {"is_active":true,"total_votes":{"$gt":1000000}}. ' +
                  'For date ranges: {"creation_date":{"$gte":"2023-01-01T00:00:00Z","$lte":"2023-12-31T23:59:59Z"}}. ' +
                  'Date strings are automatically converted to proper MongoDB date objects for comparison. ' +
                  'Supports MongoDB query operators like $gt, $lt, $gte, $lte, $in, etc.',
                type: 'string'
            },
            "sort_by": {
                description: 'Field name to sort results by. Can be any field in the table rows.',
                type: 'string'
            },
            "sort_direction": {
                description: 'Sort direction: "asc" for ascending, "desc" for descending',
                type: 'string',
                enum: ['asc', 'desc'],
                default: 'asc'
            }
        }),
        response: extendResponseSchema({
            rows_count: {
                type: "integer"
            },
            sort_by: {
                type: "string",
                description: "Field used for sorting the results"
            },
            sort_direction: {
                type: "string",
                description: "Direction of sorting (asc or desc)"
            },
            rows: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        "@pk": {
                            type: "string",
                            description: "Primary key value"
                        },
                        "@scope": {
                            type: "string",
                            description: "Scope of the table row"
                        },
                        "@block_id": {
                            type: "string",
                            description: "Block ID when the row was last modified"
                        },
                        "@block_num": {
                            type: "integer",
                            description: "Block number when the row was last modified"
                        },
                        "@block_time": {
                            type: "string",
                            description: "Block timestamp when the row was last modified"
                        },
                        "@payer": {
                            type: "string",
                            description: "Account name that paid for this row"
                        }
                    },
                    additionalProperties: true
                }
            }
        })
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        getTableRowsHandler,
        schema
    );
    next();
}
