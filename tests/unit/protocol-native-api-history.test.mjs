import {runNativeTests} from './node-test-dispatch.mjs';

runNativeTests(new URL('./protocol-native-api-history.native.mjs', import.meta.url));
