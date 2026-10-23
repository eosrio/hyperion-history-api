import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseNativeJson, parseNativeClientPacket, assertNativeServerPacket, encodeNativeServerPacket}
    from '../../build/api/stream/native-json.js';

const source = JSON.parse(readFileSync(new URL('../fixtures/native-stream-v1/source.json', import.meta.url)));
const bytes = readFileSync(new URL('../fixtures/native-stream-v1/wire-vectors.json', import.meta.url));
assert.equal(source.commit, 'bd74a84f1110653b555c85e6a058d3777eb42d71');
assert.equal(source.path, 'conformance/v1/wire-vectors.json');
assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
assert.equal(bytes.length, source.bytes);
const vectors = JSON.parse(bytes);
assert.equal(vectors.version, 1);
assert.equal(vectors.cases.length, 24);

for (const vector of vectors.cases) {
    test(`pinned native wire vector: ${vector.name}`, () => {
        const check = () => assertNativeServerPacket(parseNativeJson(vector.text));
        if (vector.valid) {
            check();
            assert.deepEqual(parseNativeJson(encodeNativeServerPacket(parseNativeJson(vector.text))), JSON.parse(vector.text));
        } else assert.throws(check);
    });
}

test('client ACK identifiers and sequence remain exact strings', () => {
    assert.deepEqual(parseNativeClientPacket('{"type":"ack","connection_id":"1","stream_id":"2","generation":"3","subscription_id":"4","sequence":"18446744073709551615"}'),
        {type: 'ack', connection_id: '1', stream_id: '2', generation: '3', subscription_id: '4', sequence: '18446744073709551615'});
});

test('pending cancellation retains distinct request and subscription identity', () => {
    assert.deepEqual(parseNativeClientPacket('{"type":"cancel","connection_id":"1","request_id":"9","stream_id":"2","generation":"3","subscription_id":null}'),
        {type: 'cancel', connection_id: '1', request_id: '9', stream_id: '2', generation: '3', subscription_id: null});
});

test('duplicate escaped identities cannot select a different scope', () => {
    assert.throws(() => parseNativeClientPacket('{"type":"pong","id":"1","\\u0069d":"2"}'), /Duplicate JSON key/);
});

test('frame limits measure UTF-8 bytes and reject invalid Unicode', () => {
    assert.throws(() => parseNativeJson('{"x":"🌐"}', 10), /too large/);
    assert.deepEqual(parseNativeJson('{"x":"🌐"}', 12), {x: '🌐'});
    assert.throws(() => parseNativeJson('{"x":"\\ud800"}'), /Unicode surrogate/);
    assert.throws(() => parseNativeJson('{"x":"\\udc00"}'), /Unicode surrogate/);
});

test('malformed client windows, identities and server-only packets are rejected', () => {
    for (const text of [
        '{"type":"ready","connection_id":"1","window":{"records":0,"bytes":1}}',
        '{"type":"ready","connection_id":"1","window":{"records":1,"bytes":67108865}}',
        '{"type":"ack","connection_id":"1","stream_id":"2","generation":"3","subscription_id":"4","sequence":"0"}',
        '{"type":"pong","id":9007199254740993}',
        '{"type":"hello","version":1}'
    ]) assert.throws(() => parseNativeClientPacket(text));
});

test('subscription JSON keeps false filters and compound identity selectors', () => {
    const request = {kind: 'delta', code: 'eosio.token', table: 'accounts', scope: '340282366920938463463374607431768211455',
        filters: [{field: 'data.enabled', value: false}], start_from: -100};
    const packet = parseNativeClientPacket(JSON.stringify({type: 'subscribe', connection_id: '1', request_id: '8',
        stream_id: '2', generation: '3', request, resume_from: 101, window: {records: 1, bytes: 1024}}));
    assert.deepEqual(packet.request, request);
    assert.equal(packet.resume_from, 101);
});

test('non-finite JSON numbers cannot silently turn into null contract values', () => {
    assert.throws(() => parseNativeJson('{"x":1e400}'), /not finite/);
    const packet = parseNativeJson(vectors.cases[0].text);
    packet.records[0].payload.act.data.value = Infinity;
    assert.throws(() => encodeNativeServerPacket(packet), /not finite/);
});
