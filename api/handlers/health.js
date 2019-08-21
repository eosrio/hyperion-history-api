const amqp = require('amqplib');
const RedisStatus = require('redis-status')({
  name: 'Redis',
  port: 6379,
  host: 'localhost'
})

function createHealth (name, status) {
  let time = Date.now()
  return {
    service: name,
    status: status,
    time: time
  }
}

async function checkRedis () {
  let result = await new Promise((resolve, reject) => {
    RedisStatus.checkStatus(err => {
      if (err) {
        resolve('Error')
      }
      resolve('OK')
    })
  })
  return createHealth ('Redis', result)
}

async function checkRabbit () {
  const amqp_username = process.env.AMQP_USER;
  const amqp_password = process.env.AMQP_PASS;
  const amqp_host = process.env.AMQP_HOST;
  const amqp_vhost = 'hyperion';
  const amqp_url = `amqp://${amqp_username}:${amqp_password}@${amqp_host}/%2F${amqp_vhost}`;
  try {
    connection = await amqp.connect(amqp_url);
    connection.close()
    return createHealth('RabbitMq', 'OK')
  } catch (e) {
    console.log(e)
    return createHealth('RabbitMq', 'Error')
  }
}

async function health (fastify, request) {
  const { elasticsearch } = fastify
  let response = {
    health: []
  }
  
  response.health.push(await checkRabbit())
  response.health.push(await checkRedis())

  try {
    let esStatus = await elasticsearch.cat.health({
      format: 'json',
      v: true
    })
    let stat = 'OK'
    esStatus.forEach(status => {
      if (status.status === 'yellow' && stat !== 'Error') {
        stat = 'Warning'
      } else if (status.status === 'red') {
        stat = 'Error'
      }
    })
    response.health.push(createHealth('Elasticsearch', stat))
  } catch (e) {
    console.log(e, 'Elasticsearch Error')
  }

  return response
}

module.exports = function (fastify, opts, next) {
  fastify.get('/health', {}, async (request) => {
    return await health(fastify, request)
  })
  next()
}