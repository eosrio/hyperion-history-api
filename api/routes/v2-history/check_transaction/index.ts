import {FastifyInstance} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions";
import {checkTransactionHandler} from "./check_transaction";

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
					type: 'string'
				}
			},
			required: ["id"]
		}
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
