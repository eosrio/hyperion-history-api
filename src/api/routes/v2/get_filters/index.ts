import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions.js";
import {getFiltersHandler} from "./get_filters.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: FastifySchema = {
        tags: ['status'],
        summary: "Active Filters on the Indexer"
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        getFiltersHandler,
        schema
    );
    next();
}
