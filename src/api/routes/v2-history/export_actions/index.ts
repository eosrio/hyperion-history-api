import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions.js";
import {getCreatorHandler} from "../get_creator/get_creator.js";

export default function (fastify: FastifyInstance, opts: any, next) {
	const schema: FastifySchema = {
		description: 'request large action data export',
		summary: 'request large action data export',
		tags: ['history']
	};
	addApiRoute(
		fastify,
		'GET',
		getRouteName(import.meta.url),
		getCreatorHandler,
		schema
	);
	next();
}
