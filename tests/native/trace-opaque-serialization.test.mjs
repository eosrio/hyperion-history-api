import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import Fastify from 'fastify';
import lodash from 'lodash';

// Load the real route and handler; only external storage, proof and timing are fixtures.
function load(file, dependencies) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace('import.meta.filename', "'get_block.ts'");
  let code = stripTypeScriptTypes(source, {mode: 'strip'});
  if (process.env.TRACE_SCHEMA_RED && file.endsWith('/index.ts')) code = code.replace('"data": {}', '"data": {additionalProperties: true}');
  code = code.replace(/import _ from "lodash";/, "const _ = require('lodash');")
    .replace(/import \{([^}]+)\} from ["']([^"']+)["'];/g, (_, names, path) => `const {${names}} = require('${path}');`)
    .replace('export default function', 'exports.default = function')
    .replace('export function getBlockTraceHandler', 'exports.getBlockTraceHandler = function');
  const exports = {};
  vm.runInNewContext(`(function(require,exports){${code}\n})`, {console})(name => {
    if (!(name in dependencies)) throw Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

test('trace HTTP serialization preserves opaque and decoded data with receipt and block metadata', async () => {
  let rows = [], proofs = 0;
  const handler = load('../../src/api/routes/v1-trace/get_block/get_block.ts', {
    lodash, fastify: {},
    '../../../helpers/functions.js': {timedQuery: (fn, app, req) => fn(app, req)},
    '../../../helpers/action-search.js': {searchActions: async () => ({hits: {hits: rows}})},
    '../../../helpers/protocol-abi.js': {protectProtocolAction: async () => {proofs++;}},
    '../../../../indexer/protocol/abi-proof.js': {ProtocolAbiProofUnavailableError: Error}
  });
  const plugin = load('../../src/api/routes/v1-trace/get_block/index.ts', {
    './get_block.js': handler, fastify: {},
    '../../../helpers/functions.js': {
      extendResponseSchema: properties => ({200: {type: 'object', properties}}),
      getRouteName: () => 'get_block',
      addApiRoute: (app, method, name, build, schema) => app.route({url: '/' + name, method, handler: build(app, name), schema})
    }
  });
  const app = Fastify();
  app.decorate('manager', {chain: 'wire', readIndexset: () => 'actions', config: {api: {limits: {}}, settings: {protocol: {provider: 'extension'}}}});
  app.decorate('elastic', {search: async () => ({hits: {hits: [{_source: {block_id: 'block-id', block_num: 2, prev_id: 'previous', '@timestamp': '2026-01-01T00:00:00', producer: 'producer'}}]}})});
  app.decorate('antelope', {chain: {get_info: async () => ({last_irreversible_block_num: 3})}});
  app.register(plugin.default);
  const payloads = ['00abcdef012345', {nested: {count: 2}, list: [1, 'x']}, '', null, [1, 'x']];
  try {
    for (const data of payloads) {
      rows = [{_source: {trx_id: 'transaction-id', block_id: 'block-id', receipts: [{receiver: 'receiver'}, {receiver: 'other'}], act: {account: 'sysio', name: 'onblock', authorization: [{actor: 'sysio', permission: 'active'}], data}}}];
      const response = await app.inject({method: 'POST', url: '/get_block', payload: {block_num: 2}});
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.equal(body.id, 'block-id'); assert.equal(body.number, 2); assert.equal(body.previous_id, 'previous'); assert.equal(body.status, 'irreversible');
      assert.equal(body.transactions[0].id, 'transaction-id');
      assert.deepEqual(body.transactions[0].actions, ['receiver', 'other'].map(receiver => ({receiver, account: 'sysio', action: 'onblock', authorization: [{account: 'sysio', permission: 'active'}], data})));
    }
    assert.equal(proofs, payloads.length);
  } finally {await app.close();}
});
