import {runNativeTests} from './node-test-dispatch.mjs';

runNativeTests(new URL('./wire-combined-replay-profile.native.mjs', import.meta.url));
