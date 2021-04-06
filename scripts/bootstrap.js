const fs = require('fs');
const path = require('path');
const {argv} = require('yargs');
const got = require('got');
const portfinder = require('portfinder');

const esClient = require('@elastic/elasticsearch');

const outputConnectionsFilename = 'connections-demo.json';
const basePath = __filename.split('bootstrap.js')[0];
const ecosystemExPath = path.join(basePath, '..', 'example-ecosystem.config.js');
if (!fs.existsSync(ecosystemExPath)) {
  console.log('Example Ecosystem File not present');
  process.exit(1);
}
const exampleEcosystem = fs.readFileSync(ecosystemExPath);
const connectionsExPath = path.join(basePath, '..', 'example-connections.json');
if (!fs.existsSync(connectionsExPath)) {
  console.log('example-connections.json not present');
  process.exit(1);
}
const exampleConnFile = JSON.parse(fs.readFileSync(connectionsExPath).toString());
const outputConnFile = path.join(basePath, '..', outputConnectionsFilename);

async function validateConnections(config, chainName) {

  if (argv['skip-validation']) {
    console.log('Connection validation skipped!');
    return true;
  } else {
    console.log('Validating connections...');
  }

  // validate elasticsearch connection
  try {
    const client = new esClient.Client({
      auth: {
        username: config.elasticsearch.user,
        password: config.elasticsearch.pass,
      },
      node: 'http://' + config.elasticsearch.host,
    });
    await client.ping();
  } catch (e) {
    console.log(`Elasticsearch validation failed: ${e.message}`);
    return false;
  }

  // validate redis connection

  // validate rabbitmq

  // validate chains

  const chain = config.chains[chainName];
  console.log(chain);
  // check http endpoint

  // check ws endpoint

  return false;
}

async function addChain() {
  console.log(`Adding new chain: ${argv.chain}`);
  let httpEndpoint = argv.http.startsWith('http') ? argv.http : 'http://' + argv.http;
  if (httpEndpoint.endsWith('/')) {
    httpEndpoint = httpEndpoint.slice(0, httpEndpoint.length - 1);
  }
  console.log('Fetching info...');
  const info = await got.get(httpEndpoint + '/v1/chain/get_info').json();
  console.log(`Name: ${argv.name}`);
  console.log(`Chain ID: ${info.chain_id}`);

  let wsRouterPort = argv['router-port'];
  if (!wsRouterPort) {
    console.log('Stream router port [--router-port] not defined. Searching for empty port...');
    wsRouterPort = await portfinder.getPortPromise({
      host: '127.0.0.1',
      port: 57200,
      stopPort: 57300,
    });
    console.log(`WS_ROUTER_PORT set to ${wsRouterPort}`);
  }

  let wsRouterHost = argv['router-host'];
  if (!wsRouterHost) {
    wsRouterHost = '127.0.0.1';
    console.log(`Stream router address [--router-host] not defined. Using "${wsRouterHost}"`);
  }

  const body = {
    'name': argv.name,
    'chain_id': info.chain_id,
    'http': httpEndpoint,
    'ship': argv.ws.startsWith('ws://') ? argv.ws : 'ws://' + argv.ws,
    'WS_ROUTER_PORT': wsRouterPort,
    'WS_ROUTER_HOST': wsRouterHost,
  };

  if (!fs.existsSync(outputConnFile)) {
    console.log('connections.json not found, please run "node scripts/bootstrap.js init" before adding chains');
  }

  const currentConnFile = JSON.parse(fs.readFileSync(outputConnFile).toString());
  console.log(`Existing chains: ${Object.keys(currentConnFile.chains).join(',')}`);
  if (currentConnFile.chains[argv.chain]) {
    console.log(`Chain "${argv.chain}" already exists!`);
  }
  currentConnFile.chains[argv.chain] = body;
  if (await validateConnections(currentConnFile, argv.chain)) {
    fs.writeFileSync(outputConnFile, JSON.stringify(currentConnFile, null, 2));
    console.log(`${outputConnectionsFilename} saved`);
  }
}

(async () => {

  if (argv['_'].includes('init')) {
    console.log('Initial Setup Mode');
    if (!argv.force && fs.existsSync(outputConnFile)) {
      console.log(`${outputConnFile} already exists! (use --force to overwrite) Aborting bootstrap!`);
      process.exit(0);
    }
    fs.writeFileSync(outputConnFile, JSON.stringify(exampleConnFile, null, 2));
  }

  if (argv['_'].includes('add-chain')) {
    console.log('Add/Update Chain Mode');
    addChain().catch((err) => {
      console.error(err);
    });
  }
})();
