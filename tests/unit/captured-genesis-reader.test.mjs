import {runNativeTests} from './node-test-dispatch.mjs';

runNativeTests(new URL('./captured-genesis-reader.native.mjs', import.meta.url));
