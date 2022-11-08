import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next: (err?: Error) => void) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.url),
        'Returns an object containing various details about the blockchain.'
    );
    next();
}
