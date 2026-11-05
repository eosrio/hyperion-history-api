// Explicit Wire34 source/runtime admission precedes the unchanged owned MongoDB projection workload.
import assert from 'node:assert/strict';
import {STATEFUL_WIRE34_CBFB_SOURCE_PROFILE,admitWire34CbfbSourceOptions} from '../../tests/unit/wire34-cbfb-source-admission.mjs';
assert.equal(process.env.HYPERION_NATIVE_SOURCE_PROFILE,STATEFUL_WIRE34_CBFB_SOURCE_PROFILE);
admitWire34CbfbSourceOptions({engineeringSourceProfile:STATEFUL_WIRE34_CBFB_SOURCE_PROFILE});
await import('./check-projection-mongodb.mjs');
