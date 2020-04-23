"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var _this = this;
Object.defineProperty(exports, "__esModule", { value: true });
var ecc = require("eosjs-ecc");
var eosjs_jssig_1 = require("../eosjs-jssig");
describe('JsSignatureProvider', function () {
    var privateKeys = ['key1', 'key2', 'key3'];
    var publicKeys = [
        'PUB_K1_8iD9ABKFH5b9JyFgb5PE51BdCV74qGN9UMfg9V3TwaExCQWxJm',
        'PUB_K1_8f2o2LLQ3phteqyazxirQZnQzQFpnjLnXiUFEJcsSYhnjWNvSX',
        'PUB_K1_5imfbmmHC83VRxLRTcvovviAc6LPpyszcDuKtkwka9e9Jg37Hp',
    ];
    it('builds public keys from private when constructed', function () { return __awaiter(_this, void 0, void 0, function () {
        var eccPkFromString, provider, actualPublicKeys;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    eccPkFromString = jest.spyOn(ecc.PrivateKey, 'fromString');
                    eccPkFromString.mockImplementation(function (k) { return ecc.PrivateKey.fromHex(ecc.sha256(k)); });
                    provider = new eosjs_jssig_1.JsSignatureProvider(privateKeys);
                    return [4 /*yield*/, provider.getAvailableKeys()];
                case 1:
                    actualPublicKeys = _a.sent();
                    expect(eccPkFromString).toHaveBeenCalledTimes(privateKeys.length);
                    expect(actualPublicKeys).toEqual(publicKeys);
                    return [2 /*return*/];
            }
        });
    }); });
    it('signs a transaction', function () { return __awaiter(_this, void 0, void 0, function () {
        var eccSignatureSign, provider, chainId, requiredKeys, serializedTransaction, abis, signOutput;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    eccSignatureSign = jest.spyOn(ecc.Signature, 'sign');
                    eccSignatureSign.mockImplementation(function (buffer, signKey) { return signKey; });
                    provider = new eosjs_jssig_1.JsSignatureProvider(privateKeys);
                    chainId = '12345';
                    requiredKeys = [
                        publicKeys[0],
                        publicKeys[2],
                    ];
                    serializedTransaction = new Uint8Array([
                        0, 16, 32, 128, 255,
                    ]);
                    abis = [];
                    return [4 /*yield*/, provider.sign({ chainId: chainId, requiredKeys: requiredKeys, serializedTransaction: serializedTransaction, abis: abis })];
                case 1:
                    signOutput = _a.sent();
                    expect(eccSignatureSign).toHaveBeenCalledTimes(2);
                    expect(signOutput).toEqual({ signatures: [privateKeys[0], privateKeys[2]], serializedTransaction: serializedTransaction });
                    return [2 /*return*/];
            }
        });
    }); });
});
//# sourceMappingURL=eosjs-jssig.test.js.map