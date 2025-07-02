import {FastifyInstance, FastifySchema} from "fastify";
import {addApiRoute, getRouteName} from "../../../helpers/functions.js";
import {explorerLogoHandler} from "./explorer_logo.js";

export default function (fastify: FastifyInstance, opts: any, next: () => void) {
    const schema: FastifySchema = {hide: true};
    addApiRoute(
        fastify,
        'GET',
        getRouteName(import.meta.filename),
        explorerLogoHandler,
        schema
    );
    next();
}
