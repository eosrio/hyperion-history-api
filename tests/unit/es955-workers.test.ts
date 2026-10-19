import {test, expect} from 'bun:test';
import {assertOwnedBinding, assertPausedRange, assertSortedPage, loadDocument} from '../../scripts/qualification/es955-workers.ts';

const page = () => ({timed_out: false, _shards: {failed: 0}, hits: {hits: [3, 2, 1].map(n =>
    ({_id: String(n), _source: loadDocument(n, 'oracle')}))}});

test('sustained query oracle rejects partial, reordered, unknown and corrupted documents', () => {
    expect(() => assertSortedPage(page(), 3, 'oracle')).not.toThrow();
    const timed = page(); timed.timed_out = true;
    expect(() => assertSortedPage(timed, 3, 'oracle')).toThrow();
    const partial = page(); partial._shards.failed = 1;
    expect(() => assertSortedPage(partial, 3, 'oracle')).toThrow();
    const reordered = page(); reordered.hits.hits.reverse();
    expect(() => assertSortedPage(reordered, 3, 'oracle')).toThrow();
    expect(() => assertSortedPage(page(), 2, 'oracle')).toThrow();
    const altered = page(); altered.hits.hits[0]._source.act.data.payload = 'changed';
    expect(() => assertSortedPage(altered, 3, 'oracle')).toThrow();
    const duplicate = page(); duplicate.hits.hits[1] = duplicate.hits.hits[0];
    expect(() => assertSortedPage(duplicate, 3, 'oracle')).toThrow();
    const empty = page(); empty.hits.hits = [];
    expect(() => assertSortedPage(empty, 3, 'oracle', 3, 3)).toThrow();
    expect(() => assertSortedPage(page(), 3, 'oracle', 3, 4)).toThrow();
});

test('fixture endpoint must match the actual owned Docker loopback binding', () => {
    const inspected = {NetworkSettings: {Ports: {'6379/tcp': [{HostIp: '127.0.0.1', HostPort: '54321'}]}}};
    expect(() => assertOwnedBinding(inspected, '6379/tcp', 'redis://127.0.0.1:54321')).not.toThrow();
    expect(() => assertOwnedBinding(inspected, '6379/tcp', 'redis://127.0.0.1:54322')).toThrow();
    expect(() => assertOwnedBinding(inspected, '27017/tcp', 'mongodb://127.0.0.1:54321')).toThrow();
});

test('reader pause oracle allows the current range and rejects a new request after a pending range', () => {
    const pause = {event: 'pause', role: 'reader', at: 100};
    const pending = {event: 'new_range', role: 'reader', at: 200};
    const continuing = {kind: 'ship_range_request', role: 'reader', at: 150};
    const live = {kind: 'ship_range_request', role: 'continuous_reader', at: 250};
    expect(() => assertPausedRange(pause, pending, [continuing, live], 300)).not.toThrow();
    expect(() => assertPausedRange(pause, pending, [continuing, {...continuing, at: 250}], 300)).toThrow();
    expect(() => assertPausedRange(pause, {...pending, at: 99}, [], 300)).toThrow();
    expect(() => assertPausedRange(pause, {...pending, at: 301}, [], 300)).toThrow();
    expect(() => assertPausedRange({...pause, role: 'continuous_reader'}, pending, [], 300)).toThrow();
});
