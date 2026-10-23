import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseNativeJson, parseNativeClientPacket, assertNativeServerPacket, encodeNativeServerPacket}
    from '../../build/api/stream/native-json.js';

const source = JSON.parse(readFileSync(new URL('../fixtures/native-stream-v1/source.json', import.meta.url)));
const bytes = readFileSync(new URL('../fixtures/native-stream-v1/wire-vectors.json', import.meta.url));
assert.equal(source.commit, '346c473f55979ff2dd841aa2bbba4bcfebc49ef7');
assert.equal(source.path, 'conformance/v1/wire-vectors.json');
assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
assert.equal(bytes.length, source.bytes);
const vectors = JSON.parse(bytes);
assert.equal(vectors.version, 1);
assert.equal(vectors.cases.length, 37);

test('all pinned protocol and integration fixtures match the source manifest byte for byte', () => {
    for (const resource of [source.manifest, ...source.resources]) {
        const content = readFileSync(new URL(`../fixtures/native-stream-v1/${resource.local_path}`, import.meta.url));
        assert.equal(createHash('sha256').update(content).digest('hex'), resource.sha256, resource.path);
        assert.equal(content.length, resource.bytes, resource.path);
    }
    const manifest = JSON.parse(readFileSync(new URL('../fixtures/native-stream-v1/manifest.json', import.meta.url)));
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.resources, source.resources.map(({path, sha256}) => ({path, sha256})));
    const scenarios = JSON.parse(readFileSync(new URL('../fixtures/native-stream-v1/scenarios.json', import.meta.url)));
    const sessions = JSON.parse(readFileSync(new URL('../fixtures/native-stream-v1/network-sessions.json', import.meta.url)));
    assert.equal(scenarios.cases.length, 24);
    assert.equal(sessions.cases.length, 2);
});

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

test('present action receipt and authorization metadata must keep their source structures', () => {
    const invalid = [
        {receipt: 'invalid'}, {receipt: []}, {receipt: ['action_receipt_v0']},
        {receipt: [1, {}]}, {receipt: ['action_receipt_v0', null]},
        {receipts: 'invalid'}, {receipts: null}, {receipts: [null]}, {receipts: [['action_receipt_v0', {}]]},
        {receipt: {auth_sequence: '18446744073709551615'}}, {receipt: {auth_sequence: null}},
        {receipt: {auth_sequence: [null]}}, {receipt: {auth_sequence: [['account', '1']]}},
        {receipt: ['action_receipt_v0', {recv_sequence: 1}]},
        {receipts: [{auth_sequence: [{sequence: 9007199254740992}]}]}
    ];
    for (const metadata of invalid) {
        const packet = parseNativeJson(vectors.cases[0].text);
        Object.assign(packet.records[0].payload, metadata);
        assert.throws(() => encodeNativeServerPacket(packet), undefined, JSON.stringify(metadata));
    }
});

test('receipt variants, grouped receipts and opaque contract JSON retain exact values', () => {
    const packet = parseNativeJson(vectors.cases[0].text), maximum = '18446744073709551615';
    const receipt = {global_sequence: maximum, recv_sequence: '0', auth_sequence: [{account: 'alice', sequence: maximum}]};
    Object.assign(packet.records[0].payload, {receipt: ['action_receipt_v0', receipt], receipts: [receipt],
        act: {data: {receipt: 'contract value', receipts: null, auth_sequence: 7, sequence: 0}}});
    assert.deepEqual(JSON.parse(encodeNativeServerPacket(packet)), packet);
    packet.records[0].payload.receipt = null;
    assert.deepEqual(JSON.parse(encodeNativeServerPacket(packet)), packet);
});

test('sequence source rules do not change unrelated root fields or numeric counts', () => {
    const packet = parseNativeJson(vectors.cases[0].text);
    Object.assign(packet.records[0].payload, {sequence: 7, recv_sequence: 8, auth_sequence: 'unrelated value',
        count: 9, code_sequence: 10, abi_sequence: 11, action_ordinal: 12});
    assert.deepEqual(JSON.parse(encodeNativeServerPacket(packet)), packet);
    packet.records[0].payload.global_sequence = 7;
    assert.throws(() => encodeNativeServerPacket(packet), /canonical decimal string/);
});

test('a data frame permits equal or increasing blocks and rejects descending blocks', () => {
    const packet = parseNativeJson(vectors.cases[0].text), first = packet.records[0];
    packet.records = [first, {...first, block_num: first.block_num}, {...first, block_num: first.block_num + 1}];
    assert.deepEqual(JSON.parse(encodeNativeServerPacket(packet)), packet);
    packet.records.reverse();
    assert.throws(() => encodeNativeServerPacket(packet), /must not decrease/);
});
