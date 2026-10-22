import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateFrames} from './aggregate-frames.mjs';
const frame = (url, functionName = 'snapshot') => ({url, functionName, scriptId: url, lineNumber: 85, columnNumber: 17});
const profile = {rootId: 1, rawSampleCount: 3, sampledIntervalMicros: 100, nodes: [
  {id: 1, parentId: null, callFrame: frame('', '(root)')},
  {id: 2, parentId: 1, callFrame: frame('/root/sdk.js')},
  {id: 3, parentId: 2, callFrame: frame('/nested/sdk.js')},
  {id: 4, parentId: 1, callFrame: frame('/other.js', 'work')}],
  stacks: [{leafNodeId: 3, nodeIds: [1, 2, 3], rawSamples: 2, intervalMicros: 20},
    {leafNodeId: 4, nodeIds: [1, 4], rawSamples: 1, intervalMicros: 80}]};
test('byte-verified aliases deduplicate inclusive recursion while preserving exclusive self counts', () => {
  const result = aggregateFrames(profile, f => f.url.endsWith('sdk.js') ? 'verified-source-sha:snapshot:85:17' : f.url || f.functionName);
  const sdk = result.find(row => row.key.startsWith('verified'));
  assert.equal(sdk.selfRawSamples, 2); assert.equal(sdk.selfIntervalMicros, 20);
  assert.equal(sdk.inclusiveRawSamples, 2); assert.equal(sdk.inclusiveIntervalMicros, 20);
  assert.equal(sdk.aliases.length, 2); assert.deepEqual(sdk.nodeIds, [3, 2]);
  assert.equal(result[0].key, '/other.js');
  assert.equal(result.find(row => row.key === '(root)').inclusiveIntervalMicros, 100);
});
test('unverified scripts stay distinct even with identical names and positions', () => {
  const result = aggregateFrames(profile, f => JSON.stringify(f));
  assert.equal(result.length, 4);
  assert.equal(result.filter(row => row.aliases[0].functionName === 'snapshot').length, 2);
});
test('derived aggregation rejects broken path and raw or weighted conservation', () => {
  for (const change of [p => p.stacks[0].nodeIds = [1, 3], p => p.rawSampleCount++, p => p.sampledIntervalMicros++]) {
    const p = structuredClone(profile); change(p); assert.throws(() => aggregateFrames(p, f => f.functionName));
  }
});
