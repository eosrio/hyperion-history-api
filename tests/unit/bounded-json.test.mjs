import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundedCanonicalJson} from '../../src/indexer/helpers/bounded-json.ts';

const byteError = 'fixture exceeds bounded JSON byte budget';
const options = maximumBytes => ({maximumBytes, errorPrefix: 'fixture'});
function exactString(value) {
    const expected = JSON.stringify(value), bytes = Buffer.byteLength(expected, 'utf8');
    assert.equal(boundedCanonicalJson(value, options(bytes)), expected);
    assert.throws(() => boundedCanonicalJson(value, options(bytes - 1)), {name: 'Error', message: byteError});
}

test('printable ASCII and retained hex keep exact JSON and UTF-8 budget boundaries', () => {
    const printable = Array.from({length: 95}, (_, i) => String.fromCharCode(i + 32)).join('');
    for (const value of ['', ' ', '~', 'plain ASCII / [] {} : ,', printable, '0123456789abcdef'.repeat(2048)]) exactString(value);
    assert.equal(boundedCanonicalJson({'z~': 'value', 'a b': '0123456789abcdef'}), '{"a b":"0123456789abcdef","z~":"value"}');
});

test('every well-formed single UTF-16 unit agrees with the independent native JSON/UTF-8 oracle', () => {
    for (let code = 0; code <= 0xffff; code++) {
        if (code >= 0xd800 && code <= 0xdfff) continue;
        exactString(String.fromCharCode(code));
    }
});

test('escapes, final newlines, non-ASCII and surrogate pairs remain on the exact general path', () => {
    for (const value of ['"', '\\', '\x7f', 'x\n', 'x\r', 'x\u2028', 'x\u2029', '\b\t\n\f\r', '\u0000\u0001',
        'é', '中', '😀', 'a😀é\\"\n', '\ud800\udc00', '\udbff\udfff']) exactString(value);
    const value = {'é\n': '😀', 'z': ['\\', '"'], 'a': {b: true}};
    const expected = '{"a":{"b":true},"z":["\\\\","\\\""],"é\\n":"😀"}';
    assert.equal(boundedCanonicalJson(value, options(Buffer.byteLength(expected))), expected);
    assert.throws(() => boundedCanonicalJson(value, options(Buffer.byteLength(expected) - 1)), {message: byteError});
});

test('malformed UTF-16 refusal still precedes string byte-budget refusal', () => {
    for (const value of ['\ud800', '\udfff', 'ascii\ud800', '\ud800\ud800', '\udfff\ud800']) {
        for (const maximumBytes of [2, 32]) assert.throws(() => boundedCanonicalJson(value, options(maximumBytes)),
            {message: 'fixture contains malformed UTF-16'});
    }
    // The original opening-quote accounting remains first when even two bytes cannot fit.
    assert.throws(() => boundedCanonicalJson('x', options(1)), {message: byteError});
});

test('ordinary keys, null prototypes and repeated references preserve canonical structure', () => {
    const shared = {x: 'ascii'}, value = Object.assign(Object.create(null), {z: shared, a: shared});
    assert.equal(boundedCanonicalJson(value), '{"a":{"x":"ascii"},"z":{"x":"ascii"}}');
    assert.equal(boundedCanonicalJson(JSON.parse('{"2":"two","10":"ten","__proto__":"plain"}')),
        '{"10":"ten","2":"two","__proto__":"plain"}');
});

test('getters, hidden fields and toJSON are refused without invoking user serialization', () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, 'x', {enumerable: true, get() {calls++; return 'bad';}});
    const hidden = Object.defineProperty({}, 'x', {enumerable: false, value: 'hidden'});
    const custom = {toJSON() {calls++; return 'bad';}};
    assert.throws(() => boundedCanonicalJson(accessor), /accessors or sparse data/);
    assert.throws(() => boundedCanonicalJson(hidden), /accessors or sparse data/);
    assert.throws(() => boundedCanonicalJson(custom), /not portable JSON/);
    assert.equal(calls, 0);
});

test('native prototypes, symbols, sparse arrays, functions and cycles retain refusal semantics', () => {
    for (const value of [new Date(), Object.create({x: 1}), {[Symbol('x')]: 1}, Buffer.from('ascii')])
        assert.throws(() => boundedCanonicalJson(value), /contains a native value/);
    const sparse = new Array(1), extra = [];
    extra.foo = 'extra';
    for (const value of [sparse, extra]) assert.throws(() => boundedCanonicalJson(value), /accessors or sparse data/);
    const cycle = {}; cycle.self = cycle;
    for (const value of [cycle, undefined, () => 'x', 1n]) assert.throws(() => boundedCanonicalJson(value), /not portable JSON/);
});

test('depth and node budgets remain independent of string encoding', () => {
    let within = null;
    for (let i = 0; i < 64; i++) within = [within];
    assert.equal(boundedCanonicalJson(within), '['.repeat(64) + 'null' + ']'.repeat(64));
    assert.throws(() => boundedCanonicalJson([within]), /node\/depth budget/);
    assert.throws(() => boundedCanonicalJson(Array(1_000_000).fill(null)), /node\/depth budget/);
});

test('number policies retain safe integer defaults and opaque finite action values', () => {
    for (const value of [0, -0, 1, -1, Number.MAX_SAFE_INTEGER]) assert.equal(boundedCanonicalJson(value), JSON.stringify(value));
    for (const value of [1.25, Number.MAX_SAFE_INTEGER + 1, Number.MIN_VALUE]) {
        assert.throws(() => boundedCanonicalJson(value), /not portable JSON/);
        assert.equal(boundedCanonicalJson(value, {numberPolicy: 'finite'}), JSON.stringify(value));
    }
    for (const value of [NaN, Infinity, -Infinity]) {
        assert.throws(() => boundedCanonicalJson(value), /not portable JSON/);
        assert.throws(() => boundedCanonicalJson(value, {numberPolicy: 'finite'}), /not portable JSON/);
    }
});
