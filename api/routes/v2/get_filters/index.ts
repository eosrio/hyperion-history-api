import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions";
import {getFiltersHandler} from "./get_filters";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: FastifySchema = {
        tags: ['status'],
        summary: "Active Filters on the Indexer"
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getFiltersHandler,
        schema
    );
    next();
}