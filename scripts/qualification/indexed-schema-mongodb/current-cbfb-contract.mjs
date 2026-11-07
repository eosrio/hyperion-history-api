// Pure identity contract. This validates supplied observations only; it grants no admission.
import assert from 'node:assert/strict';
import {DESCRIPTOR} from './cbfb-assembly.mjs';
import {NATIVE_PROFILE} from './cbfb-native-assembly.mjs';

export const CURRENT_PROFILE = 'stateful-root-sdk49-native-cbfb-full-ci-engineering-v1';
const rootSDK = 'git+https://github.com/eosrio/hyperion-sdk.git#dc20a03f2b60ba05a3369d677222a9cf0d65d299';
const nativeSDK = 'git+https://github.com/eosrio/hyperion-sdk.git#cbfb26694b90b52266d1e0b9b5dbf6f8389e736b';

export function assertCurrentSplitObservation(profile, assembly, dependencies) {
  assert.equal(profile, CURRENT_PROFILE, 'Exact current split profile required');
  assert.equal(assembly.pins.rootSDK, rootSDK, 'Root SDK pin');
  assert.equal(assembly.pins.nativeSDK, nativeSDK, 'Native SDK pin');
  assert.deepEqual(assembly, DESCRIPTOR.observation, 'Complete CBFB assembly observation');
  assert.deepEqual(dependencies, NATIVE_PROFILE.dependencies, 'Complete scoped MongoDB/BSON inventories');
  return {profile: CURRENT_PROFILE, scope: 'pure-observation-only', admitted: false};
}
