import {runNativeTests} from './node-test-dispatch.mjs';

runNativeTests(new URL('./genesis-preview-source-admission.native.mjs', import.meta.url));
