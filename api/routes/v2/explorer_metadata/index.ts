import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions";
import {explorerMetadataHandler} from "./explorer_metadata";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: FastifySchema = {
        tags: ['explorer'],
        summary: "Explorer Metadata",
        description: "Get metadata for the Hyperion Explorer"
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        explorerMetadataHandler,
        schema
    );
    next();
}