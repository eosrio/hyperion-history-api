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
var text_encoding_1 = require("text-encoding");
var eosjs_api_1 = require("../eosjs-api");
var eosjs_jsonrpc_1 = require("../eosjs-jsonrpc");
var eosjs_jssig_1 = require("../eosjs-jssig");
var transaction = {
    expiration: '2018-09-04T18:42:49',
    ref_block_num: 38096,
    ref_block_prefix: 505360011,
    max_net_usage_words: 0,
    max_cpu_usage_ms: 0,
    delay_sec: 0,
    context_free_actions: [],
    actions: [
        {
            account: 'testeostoken',
            name: 'transfer',
            authorization: [
                {
                    actor: 'thegazelle',
                    permission: 'active',
                },
            ],
            data: {
                from: 'thegazelle',
                to: 'remasteryoda',
                quantity: '1.0000 EOS',
                memo: 'For a secure future.',
            },
            hex_data: "00808a517dc354cb6012f557656ca4ba102700000000000004454f530000000014466f722\n        06120736563757265206675747572652e",
        },
        {
            account: 'testeostoken',
            name: 'transfer',
            authorization: [
                {
                    actor: 'thegazelle',
                    permission: 'active',
                },
            ],
            data: {
                from: 'thegazelle',
                to: 'remasteryoda',
                quantity: '2.0000 EOS',
                memo: 'For a second secure future (multiverse?)',
            },
            hex_data: "00808a517dc354cb6012f557656ca4ba204e00000000000004454f530000000028466f722061207365636f6e642073656\n        37572652066757475726520286d756c746976657273653f29",
        },
    ],
    transaction_extensions: [],
};
var serializedTx = [
    41, 210, 142, 91, 208, 148, 139, 46, 31, 30, 0, 0, 0, 0, 2, 48, 21, 164,
    25, 83, 149, 177, 202, 0, 0, 0, 87, 45, 60, 205, 205, 1, 0, 128, 138, 81,
    125, 195, 84, 203, 0, 0, 0, 0, 168, 237, 50, 50, 0, 48, 21, 164, 25, 83,
    149, 177, 202, 0, 0, 0, 87, 45, 60, 205, 205, 1, 0, 128, 138, 81, 125,
    195, 84, 203, 0, 0, 0, 0, 168, 237, 50, 50, 0, 0,
];
var deserializedTx = {
    actions: [
        {
            account: 'testeostoken',
            authorization: [{ actor: 'thegazelle', permission: 'active' }],
            data: '',
            name: 'transfer',
        },
        {
            account: 'testeostoken',
            authorization: [{ actor: 'thegazelle', permission: 'active' }],
            data: '',
            name: 'transfer',
        },
    ],
    context_free_actions: [],
    delay_sec: 0,
    expiration: '2018-09-04T18:42:49.000',
    max_cpu_usage_ms: 0,
    max_net_usage_words: 0,
    ref_block_num: 38096,
    ref_block_prefix: 505360011,
    transaction_extensions: [],
};
var serializedActions = [
    {
        account: 'testeostoken',
        authorization: [{ actor: 'thegazelle', permission: 'active' }],
        data: "00808A517DC354CB6012F557656CA4BA102700000000000004454F530000000014466F72206120736563757265206675747572652E",
        name: 'transfer',
    },
    {
        account: 'testeostoken',
        authorization: [{ actor: 'thegazelle', permission: 'active' }],
        data: "00808A517DC354CB6012F557656CA4BA204E00000000000004454F530000000028466F722061207365636F6E64207365637572652066757475726520286D756C746976657273653F29",
        name: 'transfer',
    },
];
var deserializedActions = [
    {
        account: 'testeostoken',
        authorization: [{ actor: 'thegazelle', permission: 'active' }],
        data: {
            from: 'thegazelle',
            memo: 'For a secure future.',
            quantity: '1.0000 EOS',
            to: 'remasteryoda',
        },
        name: 'transfer',
    },
    {
        account: 'testeostoken',
        authorization: [{ actor: 'thegazelle', permission: 'active' }],
        data: {
            from: 'thegazelle',
            memo: 'For a second secure future (multiverse?)',
            quantity: '2.0000 EOS',
            to: 'remasteryoda',
        },
        name: 'transfer',
    },
];
describe('eosjs-api', function () {
    var api;
    var fetch = function (input, init) { return __awaiter(_this, void 0, void 0, function () {
        var _this = this;
        return __generator(this, function (_a) {
            return [2 /*return*/, ({
                    ok: true,
                    json: function () { return __awaiter(_this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            if (input === '/v1/chain/get_raw_code_and_abi') {
                                return [2 /*return*/, {
                                        account_name: 'testeostoken',
                                        abi: "DmVvc2lvOjphYmkvMS4wAQxhY2NvdW50X25hbWUEbmFtZQUIdHJhbnNmZXIABARmcm9tDGFjY291bnRfbmFtZQJ0bwxhY2NvdW50X25hbWUIcXVhbnRpdHkFYXNzZXQEbWVtbwZzdHJpbmcGY3JlYXRlAAIGaXNzdWVyDGFjY291bnRfbmFtZQ5tYXhpbXVtX3N1cHBseQVhc3NldAVpc3N1ZQADAnRvDGFjY291bnRfbmFtZQhxdWFudGl0eQVhc3NldARtZW1vBnN0cmluZwdhY2NvdW50AAEHYmFsYW5jZQVhc3NldA5jdXJyZW5jeV9zdGF0cwADBnN1cHBseQVhc3NldAptYXhfc3VwcGx5BWFzc2V0Bmlzc3VlcgxhY2NvdW50X25hbWUDAAAAVy08zc0IdHJhbnNmZXLnBSMjIFRyYW5zZmVyIFRlcm1zICYgQ29uZGl0aW9ucwoKSSwge3tmcm9tfX0sIGNlcnRpZnkgdGhlIGZvbGxvd2luZyB0byBiZSB0cnVlIHRvIHRoZSBiZXN0IG9mIG15IGtub3dsZWRnZToKCjEuIEkgY2VydGlmeSB0aGF0IHt7cXVhbnRpdHl9fSBpcyBub3QgdGhlIHByb2NlZWRzIG9mIGZyYXVkdWxlbnQgb3IgdmlvbGVudCBhY3Rpdml0aWVzLgoyLiBJIGNlcnRpZnkgdGhhdCwgdG8gdGhlIGJlc3Qgb2YgbXkga25vd2xlZGdlLCB7e3RvfX0gaXMgbm90IHN1cHBvcnRpbmcgaW5pdGlhdGlvbiBvZiB2aW9sZW5jZSBhZ2FpbnN0IG90aGVycy4KMy4gSSBoYXZlIGRpc2Nsb3NlZCBhbnkgY29udHJhY3R1YWwgdGVybXMgJiBjb25kaXRpb25zIHdpdGggcmVzcGVjdCB0byB7e3F1YW50aXR5fX0gdG8ge3t0b319LgoKSSB1bmRlcnN0YW5kIHRoYXQgZnVuZHMgdHJhbnNmZXJzIGFyZSBub3QgcmV2ZXJzaWJsZSBhZnRlciB0aGUge3t0cmFuc2FjdGlvbi5kZWxheX19IHNlY29uZHMgb3Igb3RoZXIgZGVsYXkgYXMgY29uZmlndXJlZCBieSB7e2Zyb219fSdzIHBlcm1pc3Npb25zLgoKSWYgdGhpcyBhY3Rpb24gZmFpbHMgdG8gYmUgaXJyZXZlcnNpYmx5IGNvbmZpcm1lZCBhZnRlciByZWNlaXZpbmcgZ29vZHMgb3Igc2VydmljZXMgZnJvbSAne3t0b319JywgSSBhZ3JlZSB0byBlaXRoZXIgcmV0dXJuIHRoZSBnb29kcyBvciBzZXJ2aWNlcyBvciByZXNlbmQge3txdWFudGl0eX19IGluIGEgdGltZWx5IG1hbm5lci4KAAAAAAClMXYFaXNzdWUAAAAAAKhs1EUGY3JlYXRlAAIAAAA4T00RMgNpNjQBCGN1cnJlbmN5AQZ1aW50NjQHYWNjb3VudAAAAAAAkE3GA2k2NAEIY3VycmVuY3kBBnVpbnQ2NA5jdXJyZW5jeV9zdGF0cwAAAA===",
                                    }];
                            }
                            return [2 /*return*/, transaction];
                        });
                    }); },
                })];
        });
    }); };
    beforeEach(function () {
        var rpc = new eosjs_jsonrpc_1.JsonRpc('', { fetch: fetch });
        var signatureProvider = new eosjs_jssig_1.JsSignatureProvider(['5JtUScZK2XEp3g9gh7F8bwtPTRAkASmNrrftmx4AxDKD5K4zDnr']);
        var chainId = '038f4b0fc8ff18a4f0842a8f0564611f6e96e8535901dd45e43ac8691a1c4dca';
        api = new eosjs_api_1.Api({
            rpc: rpc, signatureProvider: signatureProvider, chainId: chainId, textDecoder: new text_encoding_1.TextDecoder(), textEncoder: new text_encoding_1.TextEncoder(),
        });
    });
    it('Doesnt crash', function () {
        expect(api).toBeTruthy();
    });
    it('getAbi returns an abi', function () { return __awaiter(_this, void 0, void 0, function () {
        var response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, api.getAbi('testeostoken')];
                case 1:
                    response = _a.sent();
                    expect(response).toBeTruthy();
                    return [2 /*return*/];
            }
        });
    }); });
    it('getTransactionAbis returns abis by transactions', function () { return __awaiter(_this, void 0, void 0, function () {
        var response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, api.getTransactionAbis(transaction)];
                case 1:
                    response = _a.sent();
                    expect(response[0].abi.length).toBeGreaterThan(0);
                    return [2 /*return*/];
            }
        });
    }); });
    it('getContract returns a contract', function () { return __awaiter(_this, void 0, void 0, function () {
        var response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, api.getContract('testeostoken')];
                case 1:
                    response = _a.sent();
                    expect(response.actions).toBeTruthy();
                    return [2 /*return*/];
            }
        });
    }); });
    it('deserializeTransaction converts tx from binary', function () {
        var tx = api.deserializeTransaction(serializedTx);
        expect(tx).toEqual(deserializedTx);
    });
    it('serializeActions converts actions to hex', function () { return __awaiter(_this, void 0, void 0, function () {
        var response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, api.serializeActions(transaction.actions)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(serializedActions);
                    return [2 /*return*/];
            }
        });
    }); });
    it('deserializeActions converts actions from hex', function () { return __awaiter(_this, void 0, void 0, function () {
        var response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, api.deserializeActions(serializedActions)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(deserializedActions);
                    return [2 /*return*/];
            }
        });
    }); });
    it('hasRequiredTaposFields returns true, if required fields are present', function () {
        var response = api.hasRequiredTaposFields(transaction);
        expect(response).toEqual(true);
    });
});
//# sourceMappingURL=eosjs-api.test.js.map