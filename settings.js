"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.launchDarklyConfig = void 0;
const ts_getenv_1 = require("@voice-social/ts-getenv");
exports.launchDarklyConfig = { sdkKey: (0, ts_getenv_1.getEnv)('LAUNCHDARKLY_SDK_KEY') };
//# sourceMappingURL=settings.js.map