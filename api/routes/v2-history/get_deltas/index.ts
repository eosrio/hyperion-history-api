import {FastifyInstance, FastifySchema} from "fastify";
import {getDeltasHandler} from "./get_deltas";
import {addApiRoute, extendQueryStringSchema, extendResponseSchema, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
	const schema: FastifySchema = {
		description: 'get state deltas',
		summary: 'get state deltas',
		tags: ['history'],
		querystring: extendQueryStringSchema({
			"code": {
				description: 'contract account',
				type: 'string'
			},
			"scope": {
				description: 'table scope',
				type: 'string'
			},
			"table": {
				description: 'table name',
				type: 'string'
			},
			"payer": {
				description: 'payer account',
				type: 'string'
			},
			"after": {
				description: 'filter after specified date (ISO8601)',
				type: 'string'
			},
			"before": {
				description: 'filter before specified date (ISO8601)',
				type: 'string'
			}
		}),
		response: extendResponseSchema({
			"deltas": {
				type: "array",
				items: {
					type: 'object',
					properties: {
						"timestamp": {type: 'string'},
						"code": {type: 'string'},
						"scope": {type: 'string'},
						"table": {type: 'string'},
						"primary_key": {type: 'string'},
						"payer": {type: 'string'},
						"present": {type: 'number'},
						"block_num": {type: 'number'},
						"block_id": {type: 'string'},
						"data": {
							type: 'object',
							additionalProperties: true
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
		getRouteName(__filename),
		getDeltasHandler,
		schema
	);
	next();
}

