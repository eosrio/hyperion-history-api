import {FastifyInstance} from "fastify";
import {getVotersHandler} from "./get_voters";
import {addApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    const schema = {
        description: 'get voters',
        summary: 'get voters',
        tags: ['accounts', 'state'],
        querystring: {
            type: 'object',
            properties: {
                "producer": {
                    description: 'filter by voted producer (comma separated)',
                    type: 'string'
                },
                "skip": {
                    description: 'skip [n] actions (pagination)',
                    type: 'integer',
                    minimum: 0
                },
                "limit": {
                    description: 'limit of [n] actions per page',
                    type: 'integer',
                    minimum: 1
                }
            }
        }
    };
    addApiRoute(
        fastify,
        'GET',
        getRouteName(__filename),
        getVotersHandler,
        schema
    );
    next();
}
