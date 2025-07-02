import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.filename),
        'Retrieves the current balance',
        {
            "code": {$ref: 'AccountName#'},
            "account": {$ref: 'AccountName#'},
            "symbol": {$ref: 'Symbol#'}
        },
        ["code", "account", "symbol"]
    );
    next();
}
