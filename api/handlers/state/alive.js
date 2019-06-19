module.exports = function (fastify, opts, next) {
    const {redis, elastic} = fastify;
    fastify.get('/alive', {
        schema: {
            description: 'simple server healthcheck',
            summary: 'server healthcheck',
            tags: ['state']
        }
    }, async (request, reply) => {
        elastic.ping({
            requestTimeout: 1000
        }, function (error) {
            if (error) {
                reply.send({
                    status: 'ERROR',
                    msg: 'elasticsearch cluster is not available'
                });
            } else {
                reply.send({
                    status: 'OK'
                });
            }
        });
    });
    next();
};
