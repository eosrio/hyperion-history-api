import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions";
import {getCreatorHandler} from "../get_creator/get_creator";

export default function (fastify: FastifyInstance, opts: any, next) {
	const schema: FastifySchema = {
		description: 'request large action data export',
		summary: 'request large action data export',
		tags: ['history']
	};
	addApiRoute(
		fastify,
		'GET',
		getRouteName(__filename),
		getCreatorHandler,
		schema
	);
	next();
}
