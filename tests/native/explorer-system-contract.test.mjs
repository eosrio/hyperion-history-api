import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import Fastify from 'fastify';

function load(file, dependencies) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace('import.meta.filename', "'explorer_metadata.ts'");
  let code = stripTypeScriptTypes(source, {mode: 'strip'});
  code = code.replace(/import \{([^}]+)\} from ["']([^"']+)["'];/g, (_, names, path) => `const {${names}} = require('${path}');`)
    .replace('export default function', 'exports.default = function')
    .replace('export function explorerMetadataHandler', 'exports.explorerMetadataHandler = function');
  const exports = {};
  vm.runInNewContext(`(function(require,exports){${code}\n})`, {console})(name => {
    if (!(name in dependencies)) throw Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

test('explorer metadata exposes the configured system contract with legacy and default precedence', async () => {
  const handler = load('../../src/api/routes/v2/explorer_metadata/explorer_metadata.ts', {
    fastify: {}, '../../../helpers/functions.js': {timedQuery: (fn, app) => fn(app)}
  });
  const route = load('../../src/api/routes/v2/explorer_metadata/index.ts', {
    fastify: {}, './explorer_metadata.js': handler,
    '../../../helpers/functions.js': {getRouteName: () => 'explorer_metadata',
      addApiRoute: (app, method, name, build, schema) => app.route({url: '/' + name, method, handler: build(app, name), schema})}
  });
  const app = Fastify();
  const settings = {};
  app.decorate('manager', {chain: 'wire', conn: {chains: {wire: {chain_id: 'chain-id'}}},
    config: {settings, api: {chain_name: 'Wire Testnet', provider_name: 'EOS Rio', provider_url: 'https://eosrio.io'}}});
  app.register(route.default);
  try {
    for (const [config, expected] of [
      [{system_contract: 'wire', eosio_alias: 'sysio'}, 'wire'],
      [{eosio_alias: 'sysio'}, 'sysio'],
      [{}, 'eosio'],
      [{system_contract: '', eosio_alias: 'sysio'}, '']
    ]) {
      delete settings.system_contract; delete settings.eosio_alias; Object.assign(settings, config);
      const response = await app.inject({method: 'GET', url: '/explorer_metadata'});
      assert.equal(response.statusCode, 200, response.body);
      const data = response.json(); assert.equal(data.system_contract, expected);
      assert.equal(data.chain_name, 'Wire Testnet'); assert.equal(data.chain_id, 'chain-id'); assert.equal(data.provider, 'EOS Rio');
    }
  } finally { await app.close(); }
});
