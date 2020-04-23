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
var eosjs_jsonrpc_1 = require("../eosjs-jsonrpc");
var eosjs_rpcerror_1 = require("../eosjs-rpcerror");
describe('JSON RPC', function () {
    var endpoint = 'http://localhost';
    var fetchMock = fetch;
    var jsonRpc;
    beforeEach(function () {
        fetchMock.resetMocks();
        jsonRpc = new eosjs_jsonrpc_1.JsonRpc(endpoint);
    });
    it('throws error bad status', function () { return __awaiter(_this, void 0, void 0, function () {
        var actMessage, expMessage, accountName, expReturn, e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    actMessage = '';
                    expMessage = 'Not Found';
                    accountName = 'myaccountaaa';
                    expReturn = { data: '12345', message: expMessage };
                    fetchMock.once(JSON.stringify(expReturn), { status: 404 });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, jsonRpc.get_abi(accountName)];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 3:
                    e_1 = _a.sent();
                    expect(e_1).toBeInstanceOf(eosjs_rpcerror_1.RpcError);
                    actMessage = e_1.message;
                    return [3 /*break*/, 4];
                case 4:
                    expect(actMessage).toEqual(expMessage);
                    return [2 /*return*/];
            }
        });
    }); });
    it('throws error unprocessed', function () { return __awaiter(_this, void 0, void 0, function () {
        var actMessage, expMessage, accountName, expReturn, e_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    actMessage = '';
                    expMessage = 'Not Processed';
                    accountName = 'myaccountaaa';
                    expReturn = {
                        data: '12345',
                        processed: {
                            except: {
                                message: expMessage,
                            },
                        },
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, jsonRpc.get_abi(accountName)];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 3:
                    e_2 = _a.sent();
                    expect(e_2).toBeInstanceOf(eosjs_rpcerror_1.RpcError);
                    actMessage = e_2.message;
                    return [3 /*break*/, 4];
                case 4:
                    expect(actMessage).toEqual(expMessage);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls provided fetch instead of default', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, accountName, expReturn, expParams, mockResp, myFetch;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_abi';
                    accountName = 'myaccountaaa';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            account_name: accountName,
                        }),
                        method: 'POST',
                    };
                    mockResp = {
                        json: function () {
                            return expReturn;
                        },
                        ok: true,
                    };
                    myFetch = jest.fn();
                    myFetch.mockReturnValue(mockResp);
                    jsonRpc = new eosjs_jsonrpc_1.JsonRpc(endpoint, { fetch: myFetch });
                    return [4 /*yield*/, jsonRpc.get_abi(accountName)];
                case 1:
                    _a.sent();
                    expect(myFetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_abi', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, accountName, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_abi';
                    accountName = 'myaccountaaa';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            account_name: accountName,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_abi(accountName)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_account', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, accountName, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_account';
                    accountName = 'myaccountaaa';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            account_name: accountName,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_account(accountName)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_block_header_state', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, blockNumOrId, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_block_header_state';
                    blockNumOrId = 1234;
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            block_num_or_id: blockNumOrId,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_block_header_state(blockNumOrId)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_block', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, blockNumOrId, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_block';
                    blockNumOrId = 1234;
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            block_num_or_id: blockNumOrId,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_block(blockNumOrId)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_code', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, accountName, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_code';
                    accountName = 'myaccountaaa';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            account_name: accountName,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_code(accountName)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_currency_balance with all params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, code, account, symbol, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_currency_balance';
                    code = 'morse';
                    account = 'myaccountaaa';
                    symbol = 'EOS';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            code: code,
                            account: account,
                            symbol: symbol,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_currency_balance(code, account, symbol)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_currency_balance with default params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, code, account, symbol, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_currency_balance';
                    code = 'morse';
                    account = 'myaccountaaa';
                    symbol = null;
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            code: code,
                            account: account,
                            symbol: symbol,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_currency_balance(code, account)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_currency_stats with all params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, code, symbol, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_currency_stats';
                    code = 'morse';
                    symbol = 'EOS';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            code: code,
                            symbol: symbol,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_currency_stats(code, symbol)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_info', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_info';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({}),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_info()];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_producer_schedule', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_producer_schedule';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({}),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_producer_schedule()];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_producers with all params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, json, lowerBound, limit, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_producers';
                    json = false;
                    lowerBound = 'zero';
                    limit = 10;
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            json: json,
                            lower_bound: lowerBound,
                            limit: limit,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_producers(json, lowerBound, limit)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_producers with default params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, json, lowerBound, limit, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_producers';
                    json = true;
                    lowerBound = '';
                    limit = 50;
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            json: json,
                            lower_bound: lowerBound,
                            limit: limit,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_producers()];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_raw_code_and_abi', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, accountName, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_raw_code_and_abi';
                    accountName = 'myaccountaaa';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            account_name: accountName,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_raw_code_and_abi(accountName)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_table_rows with all params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, json, code, scope, table, tableKey, lowerBound, upperBound, limit, indexPosition, keyType, expReturn, reverse, showPayer, callParams, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_table_rows';
                    json = false;
                    code = 'morse';
                    scope = 'minty';
                    table = 'coffee';
                    tableKey = 'front_door';
                    lowerBound = 'zero';
                    upperBound = 'five';
                    limit = 20;
                    indexPosition = 1;
                    keyType = 'str';
                    expReturn = { data: '12345' };
                    reverse = false;
                    showPayer = false;
                    callParams = {
                        json: json,
                        code: code,
                        scope: scope,
                        table: table,
                        table_key: tableKey,
                        lower_bound: lowerBound,
                        upper_bound: upperBound,
                        index_position: indexPosition,
                        key_type: keyType,
                        limit: limit,
                        reverse: reverse,
                        show_payer: showPayer,
                    };
                    expParams = {
                        body: JSON.stringify(callParams),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_table_rows(callParams)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_table_rows with default params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, json, code, scope, table, tableKey, lowerBound, upperBound, limit, indexPosition, keyType, reverse, showPayer, expReturn, callParams, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_table_rows';
                    json = true;
                    code = 'morse';
                    scope = 'minty';
                    table = 'coffee';
                    tableKey = '';
                    lowerBound = '';
                    upperBound = '';
                    limit = 10;
                    indexPosition = 1;
                    keyType = '';
                    reverse = false;
                    showPayer = false;
                    expReturn = { data: '12345' };
                    callParams = {
                        code: code,
                        scope: scope,
                        table: table,
                    };
                    expParams = {
                        body: JSON.stringify({
                            json: json,
                            code: code,
                            scope: scope,
                            table: table,
                            table_key: tableKey,
                            lower_bound: lowerBound,
                            upper_bound: upperBound,
                            index_position: indexPosition,
                            key_type: keyType,
                            limit: limit,
                            reverse: reverse,
                            show_payer: showPayer,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_table_rows(callParams)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_table_by_scope with all params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, code, table, lowerBound, upperBound, limit, expReturn, callParams, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_table_by_scope';
                    code = 'morse';
                    table = 'coffee';
                    lowerBound = 'minty';
                    upperBound = 'minty';
                    limit = 20;
                    expReturn = { data: '12345' };
                    callParams = {
                        code: code,
                        table: table,
                        lower_bound: lowerBound,
                        upper_bound: upperBound,
                        limit: limit,
                    };
                    expParams = {
                        body: JSON.stringify(callParams),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_table_by_scope(callParams)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls get_table_by_scope with default params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, code, table, lowerBound, upperBound, limit, expReturn, callParams, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_table_by_scope';
                    code = 'morse';
                    table = 'coffee';
                    lowerBound = '';
                    upperBound = '';
                    limit = 10;
                    expReturn = { data: '12345' };
                    callParams = {
                        code: code,
                        table: table,
                    };
                    expParams = {
                        body: JSON.stringify({
                            code: code,
                            table: table,
                            lower_bound: lowerBound,
                            upper_bound: upperBound,
                            limit: limit,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.get_table_by_scope(callParams)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls getRequiredKeys', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, keys, expReturn, callParams, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/get_required_keys';
                    keys = ['key1', 'key2', 'key3'];
                    expReturn = { required_keys: keys };
                    callParams = {
                        transaction: 'mytxn',
                        availableKeys: keys,
                    };
                    expParams = {
                        body: JSON.stringify({
                            transaction: callParams.transaction,
                            available_keys: callParams.availableKeys,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.getRequiredKeys(callParams)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn.required_keys);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls push_transaction', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, signatures, serializedTransaction, limit, expReturn, callParams, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/chain/push_transaction';
                    signatures = [
                        'George Washington',
                        'John Hancock',
                        'Abraham Lincoln',
                    ];
                    serializedTransaction = new Uint8Array([
                        0, 16, 32, 128, 255,
                    ]);
                    limit = 50;
                    expReturn = { data: '12345' };
                    callParams = {
                        signatures: signatures,
                        serializedTransaction: serializedTransaction,
                    };
                    expParams = {
                        body: JSON.stringify({
                            signatures: signatures,
                            compression: 0,
                            packed_context_free_data: '',
                            packed_trx: '00102080ff',
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.push_transaction(callParams)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls db_size_get', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/db_size/get';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({}),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.db_size_get()];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls history_get_actions with all params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, accountName, pos, offset, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/history/get_actions';
                    accountName = 'myaccountaaa';
                    pos = 5;
                    offset = 10;
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            account_name: accountName,
                            pos: pos,
                            offset: offset,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.history_get_actions(accountName, pos, offset)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls history_get_actions with default params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, accountName, pos, offset, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/history/get_actions';
                    accountName = 'myaccountaaa';
                    pos = null;
                    offset = null;
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            account_name: accountName,
                            pos: pos,
                            offset: offset,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.history_get_actions(accountName)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls history_get_transaction with all params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, id, blockNumHint, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/history/get_transaction';
                    id = 'myaccountaaa';
                    blockNumHint = 20;
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            id: id,
                            block_num_hint: blockNumHint,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.history_get_transaction(id, blockNumHint)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls history_get_transaction with default params', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, id, blockNumHint, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/history/get_transaction';
                    id = 'myaccountaaa';
                    blockNumHint = null;
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            id: id,
                            block_num_hint: blockNumHint,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.history_get_transaction(id)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls history_get_key_accounts', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, publicKey, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/history/get_key_accounts';
                    publicKey = 'key12345';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            public_key: publicKey,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.history_get_key_accounts(publicKey)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
    it('calls history_get_controlled_accounts', function () { return __awaiter(_this, void 0, void 0, function () {
        var expPath, controllingAccount, expReturn, expParams, response;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    expPath = '/v1/history/get_controlled_accounts';
                    controllingAccount = 'key12345';
                    expReturn = { data: '12345' };
                    expParams = {
                        body: JSON.stringify({
                            controlling_account: controllingAccount,
                        }),
                        method: 'POST',
                    };
                    fetchMock.once(JSON.stringify(expReturn));
                    return [4 /*yield*/, jsonRpc.history_get_controlled_accounts(controllingAccount)];
                case 1:
                    response = _a.sent();
                    expect(response).toEqual(expReturn);
                    expect(fetch).toBeCalledWith(endpoint + expPath, expParams);
                    return [2 /*return*/];
            }
        });
    }); });
});
//# sourceMappingURL=eosjs-jsonrpc.test.js.map