import {runNativeTests} from './node-test-dispatch.mjs';

runNativeTests(new URL('./immutable-batch-source-admission.native.mjs', import.meta.url));
