import test from 'node:test';
import assert from 'node:assert/strict';
import {DESCRIPTOR} from './cbfb-assembly.mjs';
import {NATIVE_PROFILE} from './cbfb-native-assembly.mjs';
import {CURRENT_PROFILE, assertCurrentSplitObservation} from './current-cbfb-contract.mjs';

test('current split is explicit and rejects mislabeled or mutated observations', () => {
  const assembly = structuredClone(DESCRIPTOR.observation);
  const deps = structuredClone(NATIVE_PROFILE.dependencies);
  assert.equal(assertCurrentSplitObservation(CURRENT_PROFILE, assembly, deps).admitted, false);
  for (const profile of [undefined, 'stateful-sdk49-indexed-2da-linux-engineering-v1', 'unknown']) {
    assert.throws(() => assertCurrentSplitObservation(profile, assembly, deps));
  }
  for (const key of ['rootSDK', 'nativeSDK']) {
    const bad = structuredClone(assembly);
    bad.pins[key] = bad.pins[key === 'rootSDK' ? 'nativeSDK' : 'rootSDK'];
    assert.throws(() => assertCurrentSplitObservation(CURRENT_PROFILE, bad, deps));
  }
  const bad = structuredClone(deps);
  delete bad['native:bson'];
  assert.throws(() => assertCurrentSplitObservation(CURRENT_PROFILE, assembly, bad));
});
