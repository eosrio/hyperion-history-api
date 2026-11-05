import {runNativeTests} from './node-test-dispatch.mjs';

runNativeTests(new URL('./captured-genesis-master.native.mjs', import.meta.url));
