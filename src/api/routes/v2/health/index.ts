import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions.js";
import {healthHandler} from "./health.js";

export default function (fastify: FastifyInstance, opts: any, next: (err?: Error) => void) {
    const schema: FastifySchema = {
        tags: ['status'],
        summary: "API Service Health Report"
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.url),
        healthHandler,
        schema
    );
    next();
}
