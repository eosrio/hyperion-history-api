import { addApiRoute, getRouteName } from "../../../helpers/functions.js";
import { healthHandler } from "./health.js";
export default function (fastify, opts, next) {
    const schema = {
        tags: ['status'],
        summary: "API Service Health Report"
    };
    addApiRoute(fastify, 'GET', getRouteName(__filename), healthHandler, schema);
    next();
}
