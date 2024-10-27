import {FastifyInstance} from "fastify";
import {addApiRoute, extendResponseSchema, getRouteName} from "../../../helpers/functions.js";
import {checkTransactionHandler} from "./check_transaction.js";

export default function (fastify: FastifyInstance, opts: any, next) {
	const schema = {
		description: 'check if a transaction was included in a block',
		summary: 'check if a transaction was included in a block',
		tags: ['history'],
		querystring: {
			type: 'object',
			properties: {
				"id": {
					description: 'transaction id',
					type: 'string',
					minLength: 64,
					maxLength: 64
				}
			},
			required: ["id"]
		},
		response: extendResponseSchema({
			"id": {type: "string"},
			"status": {type: "string"},
			"block_num": {type: "number"},
			"root_action": {
				type: "object",
				properties: {
					"account": {type: "string"},
					"name": {type: "string"},
					"authorization": {
						type: "array",
						items: {
							type: 'object',
							properties: {
								"actor": {type: "string"},
								"permission": {type: "string"}
							}
						}
					},
					"data": {type: "string"}
				}
			},
			"signatures": {type: "array", items: {type: 'string'}}
		})
	};
	addApiRoute(
		fastify,
		'GET',
		getRouteName(__filename),
		checkTransactionHandler,
		schema
	);
	next();
}
