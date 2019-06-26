module.exports = function (fastify, opts, next) {
    const {redis, elastic} = fastify;
    fastify.get('/alive', {
        schema: {
            description: 'simple server healthcheck',
            summary: 'server healthcheck',
            tags: ['state']
        }
    }, async (request, reply) => {
        elastic.ping().then(()=>{
            reply.send({
                status: 'OK'
            });
        }).catch(()=>{
            reply.send({
                status: 'ERROR',
                msg: 'elasticsearch cluster is not available'
            });
        });
    });
    next();
};
