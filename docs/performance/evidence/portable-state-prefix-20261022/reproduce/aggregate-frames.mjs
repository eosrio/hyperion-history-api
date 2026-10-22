import assert from 'node:assert/strict';

/** Re-aggregate validated leaf stacks. Inclusive buckets are unions per stack. */
export function aggregateFrames(profile, keyForFrame) {
  assert.ok(profile.nodes.length <= 100000 && profile.stacks.length <= 100000);
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const groups = new Map();
  const get = node => {
    const key = keyForFrame(node.callFrame, node);
    assert.equal(typeof key, 'string'); assert.ok(key.length > 0);
    if (!groups.has(key)) groups.set(key, {key, aliases: new Map(), nodeIds: new Set(), selfRawSamples: 0,
      selfIntervalMicros: 0, inclusiveRawSamples: 0, inclusiveIntervalMicros: 0});
    const value = groups.get(key);
    value.aliases.set(JSON.stringify(node.callFrame), node.callFrame); value.nodeIds.add(node.id);
    return value;
  };
  let totalRaw = 0, totalWeight = 0, visits = 0;
  for (const stack of profile.stacks) {
    assert.ok(Number.isSafeInteger(stack.rawSamples) && stack.rawSamples > 0);
    assert.ok(Number.isSafeInteger(stack.intervalMicros) && stack.intervalMicros >= 0);
    assert.ok(stack.nodeIds.length > 0 && stack.nodeIds.length <= 2048);
    const leaf = nodes.get(stack.leafNodeId);
    assert.equal(stack.nodeIds.at(-1), leaf.id);
    const own = get(leaf); own.selfRawSamples += stack.rawSamples; own.selfIntervalMicros += stack.intervalMicros;
    const seen = new Set();
    for (let i = 0; i < stack.nodeIds.length; ++i) {
      assert.ok(++visits <= 2000000);
      const node = nodes.get(stack.nodeIds[i]); assert.ok(node);
      if (i === 0) assert.equal(node.id, profile.rootId);
      else assert.equal(node.parentId, stack.nodeIds[i - 1]);
      const value = get(node);
      if (!seen.has(value.key)) {
        seen.add(value.key); value.inclusiveRawSamples += stack.rawSamples; value.inclusiveIntervalMicros += stack.intervalMicros;
      }
    }
    totalRaw += stack.rawSamples; totalWeight += stack.intervalMicros;
  }
  assert.equal(totalRaw, profile.rawSampleCount); assert.equal(totalWeight, profile.sampledIntervalMicros);
  const result = [...groups.values()].map(value => ({...value, aliases: [...value.aliases.values()], nodeIds: [...value.nodeIds],
    selfRawPercent: 100 * value.selfRawSamples / totalRaw, selfIntervalPercent: 100 * value.selfIntervalMicros / totalWeight,
    inclusiveRawPercent: 100 * value.inclusiveRawSamples / totalRaw, inclusiveIntervalPercent: 100 * value.inclusiveIntervalMicros / totalWeight}));
  assert.equal(result.reduce((sum, row) => sum + row.selfRawSamples, 0), totalRaw);
  assert.equal(result.reduce((sum, row) => sum + row.selfIntervalMicros, 0), totalWeight);
  return result.sort((a, b) => b.selfIntervalMicros - a.selfIntervalMicros || a.key.localeCompare(b.key));
}
