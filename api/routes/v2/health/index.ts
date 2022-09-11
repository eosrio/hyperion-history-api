import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions";
import {healthHandler} from "./health";

export default function (fastify: FastifyInstance, opts: any, next) {
	const schema: FastifySchema = {
		tags: ['status'],
		summary: "API Service Health Report"
	};
	addApiRoute(
		fastify,
		'GET',
		getRouteName(__filename),
		healthHandler,
		schema
	);
	next();
}
