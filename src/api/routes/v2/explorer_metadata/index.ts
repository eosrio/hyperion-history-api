import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions.js";
import {explorerMetadataHandler} from "./explorer_metadata.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema: FastifySchema = {
        tags: ['explorer'],
        summary: "Explorer Metadata",
        description: "Get metadata for the Hyperion Explorer"
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        explorerMetadataHandler,
        schema
    );
    next();
}
