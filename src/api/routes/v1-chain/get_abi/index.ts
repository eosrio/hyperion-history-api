import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next: (err?: Error) => void) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.url),
        'Retrieves the ABI for a contract based on its account name',
        {"account_name": {$ref: 'AccountName#'}},
        ["account_name"]
    );
    next();
}
