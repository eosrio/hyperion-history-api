/** Private, opt-in evidence only. Never consumes a queue or issues restore/source/ACK authority. */
import {createHash, randomUUID} from 'node:crypto';
import {openSync, writeSync, fsyncSync, closeSync} from 'node:fs';
const hash = value => createHash('sha256').update(value).digest('hex');
const issued = new WeakSet();
export const wireBacklogCaptureLimits = Object.freeze({maximumRows: 16384, maximumBytes: 32 * 1024 * 1024,
    maximumBodyBytes: 1024 * 1024, maximumValueBytes: 128 * 1024, maximumNodes: 8192, maximumDepth: 16});
const missing = Object.freeze(['atomic-store-snapshot', 'complete-genesis-coverage', 'exact-queued-and-active-membership',
    'publication-confirm-and-drain-outcomes', 'fresh-source-and-worker-ownership', 'physical-credit-owner-restoration']);
const need = (ok, message) => {if (!ok) throw new Error(message);};
// JSON may escape one raw UTF-8 byte as six ASCII bytes. Tags/container punctuation
// and finite-number spellings add bounded per-node overhead; logical limits stay unchanged.
const encodedLimit = bounds => 6 * bounds.maximumValueBytes + 64 * bounds.maximumNodes + 64;
const own = (value, name) => {
    const d = value && Object.getOwnPropertyDescriptor(value, name);
    if (!d) return undefined;
    need('value' in d, 'Capture refuses accessors'); return d.value;
};

/** Preserve typed headers/Buffer/undefined/bigint/-0 without invoking data getters. */
export function encodeWireBacklogValue(value, bounds = wireBacklogCaptureLimits) {
    let nodes = 0, bytes = 0; const active = new Set();
    const charge = n => {bytes += n; need(bytes <= bounds.maximumValueBytes, 'Capture value byte bound');};
    const visit = (v, depth) => {
        need(++nodes <= bounds.maximumNodes && depth <= bounds.maximumDepth, 'Capture value structural bound');
        if (v === null) return ['null'];
        if (v === undefined) return ['undefined'];
        if (typeof v === 'boolean') return ['boolean', v];
        if (typeof v === 'number') {need(Number.isFinite(v), 'Non-finite capture value'); return ['number', Object.is(v, -0) ? '-0' : String(v)];}
        if (typeof v === 'bigint') {const text = String(v); charge(text.length); return ['bigint', text];}
        if (typeof v === 'string') {charge(Buffer.byteLength(v)); return ['string', v];}
        if (Buffer.isBuffer(v)) {charge(v.length); return ['buffer', v.toString('base64')];}
        need(v && typeof v === 'object' && !active.has(v), 'Unsupported or cyclic capture value');
        need(Object.getOwnPropertySymbols(v).length === 0, 'Symbol capture value');
        active.add(v);
        try {
            if (Array.isArray(v)) {
                need(v.length <= bounds.maximumNodes && Object.keys(v).length === v.length, 'Sparse or extended capture array');
                return ['array', Array.from({length: v.length}, (_, i) => {need(Object.hasOwn(v, i), 'Sparse capture array'); return visit(own(v, String(i)), depth + 1);})];
            }
            need([Object.prototype, null].includes(Object.getPrototypeOf(v)), 'Non-data capture object');
            return ['object', Object.keys(v).map(key => {charge(Buffer.byteLength(key)); return [key, visit(own(v, key), depth + 1)];})];
        } finally {active.delete(v);}
    };
    const encoded = visit(value, 0);
    need(Buffer.byteLength(JSON.stringify(encoded)) <= encodedLimit(bounds), 'Encoded value byte bound');
    return encoded;
}

export function decodeWireBacklogValue(encoded, bounds = wireBacklogCaptureLimits) {
    // Validate a bounded detached encoding before recursion/allocation.
    const text = JSON.stringify(encoded); need(typeof text === 'string' && Buffer.byteLength(text) <= encodedLimit(bounds), 'Encoded value byte bound');
    let nodes = 0;
    const visit = (v, depth) => {
        need(++nodes <= bounds.maximumNodes && depth <= bounds.maximumDepth
            && Array.isArray(v) && typeof v[0] === 'string', 'Malformed encoded capture value');
        const [tag, x] = v;
        if (tag === 'null' || tag === 'undefined') {need(v.length === 1, 'Malformed null capture'); return tag === 'null' ? null : undefined;}
        need(v.length === 2, 'Malformed tagged capture value');
        if (tag === 'boolean') {need(typeof x === 'boolean', 'Malformed boolean'); return x;}
        if (tag === 'string') {need(typeof x === 'string', 'Malformed string'); return x;}
        if (tag === 'number') {need(typeof x === 'string' && (x === '-0' || String(Number(x)) === x) && Number.isFinite(Number(x)), 'Malformed number'); return Number(x);}
        if (tag === 'bigint') {need(typeof x === 'string' && /^(0|-?[1-9][0-9]*)$/.test(x), 'Malformed bigint'); return BigInt(x);}
        if (tag === 'buffer') {need(typeof x === 'string' && Buffer.from(x, 'base64').toString('base64') === x, 'Malformed buffer'); return Buffer.from(x, 'base64');}
        need(Array.isArray(x), 'Malformed container');
        if (tag === 'array') return x.map(child => visit(child, depth + 1));
        need(tag === 'object', 'Unknown capture tag'); const out = Object.create(null), seen = new Set();
        for (const row of x) {
            need(Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && !seen.has(row[0]), 'Duplicate/malformed object key');
            seen.add(row[0]); Object.defineProperty(out, row[0], {value: visit(row[1], depth + 1), enumerable: true, writable: true, configurable: true});
        }
        return out;
    };
    const decoded = visit(encoded, 0);
    // Use the writer's raw logical-byte accounting, structural bounds and canonical
    // typed representation too, including any reduced bounds declared by this file.
    need(JSON.stringify(encodeWireBacklogValue(decoded, bounds)) === text, 'Non-canonical capture value');
    return decoded;
}

export function createWireBacklogCapture({enabled = false, identity, limits = wireBacklogCaptureLimits} = {}) {
    if (!enabled) return undefined;
    need(identity && /^hyp-p191-[0-9a-f]{12}$/.test(identity.chain) && /^[0-9a-f]{40}$/.test(identity.sourceHead)
        && /^[0-9a-f]{64}$/.test(identity.configurationSha256) && Number.isSafeInteger(identity.pid) && identity.pid > 0,
    'Owned native qualification identity required');
    for (const name of Object.keys(wireBacklogCaptureLimits)) need(Number.isSafeInteger(limits[name]) && limits[name] > 0
        && limits[name] <= wireBacklogCaptureLimits[name], 'Capture bounds may only be reduced');
    limits = Object.freeze({...limits});
    const rows = [], detached = decodeWireBacklogValue(encodeWireBacklogValue(identity));
    let retainedBytes = 0, omitted = 0, failures = 0;
    const result = {
        observe(kind, snapshot) {
            try {
                if (rows.length >= limits.maximumRows) {omitted++; return;}
                const value = snapshot(); const body = value.body;
                need(body === undefined || Buffer.isBuffer(body), 'Capture body must be original bytes');
                need(body === undefined || body.length <= limits.maximumBodyBytes, 'Capture body bound');
                const {body: _body, ...fields} = value;
                const encoded = encodeWireBacklogValue(fields, limits);
                const row = {sequence: rows.length + 1, kind, monotonicNs: process.hrtime.bigint().toString(), value: encoded,
                    ...(body === undefined ? {} : {body: {bytes: body.length, sha256: hash(body), base64: body.toString('base64')}})};
                const text = JSON.stringify(row), bytes = Buffer.byteLength(text) + 1;
                if (retainedBytes + bytes > limits.maximumBytes - 4096) {omitted++; return;}
                rows.push(text); retainedBytes += bytes;
            } catch {failures++;}
        },
        failure() {failures++;},
        snapshot() {return {schemaVersion: 1, kind: 'wire-backlog-evidence', captureId, observationOnly: true,
            restorable: false, settlementAuthority: false, identity: decodeWireBacklogValue(encodeWireBacklogValue(detached)), limits: {...limits}, retainedBytes,
            omitted, failures, missing: [...missing], rows: rows.map(text => JSON.parse(text))};}
    };
    const captureId = randomUUID(); issued.add(result); return result;
}

/** Capture at the actual original methods; return/callback/Promise/error identities remain unchanged. */
export function installWireBacklogCapture(options) {
    const capture = options.capture;
    if (!capture) return;
    const {WorkerHost, Reader, currentScope} = options;
    need(issued.has(capture) && typeof currentScope === 'function', 'Issued capture required');
    const contexts = new WeakMap(), publishers = new WeakSet(), ids = new WeakMap(); let nextId = 0;
    const id = object => {if (!object || typeof object !== 'object') return null; if (!ids.has(object)) ids.set(object, ++nextId); return ids.get(object);};
    const attempt = (worker, message) => {
        const receipt = worker.workerAttemptDeliveries?.get(message);
        return receipt ? {receiptId: receipt.receiptId, originalConsumerId: id(receipt.consumer),
            payloadSha256: receipt.payloadSha256, headersSha256: receipt.headersSha256,
            attempt: worker.workerAttemptClient.describe(receipt.handle),
            parentAuthority: worker.workerAttemptClient.authority ?? null} : {unavailable: true};
    };
    const owner = WorkerHost.prototype.actionPublicationOwner;
    WorkerHost.prototype.actionPublicationOwner = function (...args) {
        const value = owner.apply(this, args);
        try {
            const scope = currentScope(); need(scope && typeof scope === 'object', 'Original proof scope unavailable');
            contexts.set(scope, {worker: this, message: args[0], owner: value});
            const publisher = value.publisher;
            if (!publishers.has(publisher)) {
                const send = publisher.sendToQueue;
                publisher.sendToQueue = function (...sendArgs) {
                    capture.observe('publication-invoked-outcome-unknown', () => {
                        const context = contexts.get(currentScope()); need(context?.owner.publisher === this, 'Original publisher scope unavailable');
                        const [queue, body, properties] = sendArgs;
                        need(queue.startsWith(context.worker.chain + ':'), 'Foreign publication queue');
                        return {queue, body, properties, custody: attempt(context.worker, context.message),
                            publisherObservationId: id(this), confirmed: 'unknown', drained: 'unknown', businessSettlement: 'unknown'};
                    });
                    return send.apply(this, sendArgs);
                };
                publishers.add(publisher);
            }
        } catch {capture.failure();}
        return value;
    };
    const delivery = WorkerHost.prototype.captureWorkerAttemptDelivery;
    WorkerHost.prototype.captureWorkerAttemptDelivery = function (...args) {
        const value = delivery.apply(this, args);
        capture.observe('original-consumer-delivery', () => {
            const [message, channel, kind] = args;
            return {kind, body: own(message, 'content'), properties: own(message, 'properties'), fields: own(message, 'fields'),
                consumerObservationId: id(channel), custody: attempt(this, message), acknowledgement: 'unknown', businessSettlement: 'unknown'};
        });
        return value;
    };
    const credit = reader => {
        const pending = reader.withheldShipCredits, context = reader.sourceContext;
        return {paused: reader.backpressurePaused, finishing: reader.finishing, publisherFailure: !!reader.publisherFailure,
            physicalIngressGeneration: reader.physicalIngressGeneration, socketGeneration: reader.socketGeneration,
            context: context ? {id: context.id, readerSessionId: context.readerSessionId, generation: context.generation} : null,
            withheld: pending ? {count: pending.count, generation: pending.owner.generation,
                epochObservationId: id(pending.owner.epoch), sessionObservationId: id(pending.owner.session)} : null,
            grantsOrAuthorityIssuedByCapture: false};
    };
    for (const name of ['flushShipCredits', 'onIpcMessage']) {
        const original = Reader.prototype[name]; need(typeof original === 'function', 'Original reader seam unavailable');
        Reader.prototype[name] = function (...args) {
            let selected = name === 'flushShipCredits';
            try {selected ||= ['pause', 'resume'].includes(own(args[0], 'event'));} catch {capture.failure();}
            if (selected) capture.observe('credit-before-' + name, () => credit(this));
            try {return original.apply(this, args);}
            finally {if (selected) capture.observe('credit-after-' + name, () => credit(this));}
        };
    }
}

/** Single bounded diagnostic write at terminal exit. A file is never a store/queue savepoint. */
export function writeWireBacklogCapture(capture, path) {
    need(issued.has(capture), 'Issued capture required'); const snapshot = capture.snapshot(), bytes = Buffer.from(JSON.stringify(snapshot) + '\n');
    need(bytes.length <= snapshot.limits.maximumBytes, 'Capture file byte bound'); const descriptor = openSync(path, 'wx', 0o600);
    try {let offset = 0; while (offset < bytes.length) {const written = writeSync(descriptor, bytes, offset); need(written > 0, 'Capture write made no progress'); offset += written;} fsyncSync(descriptor);}
    finally {closeSync(descriptor);}
    return {bytes: bytes.length, sha256: hash(bytes), omitted: snapshot.omitted, failures: snapshot.failures,
        restorable: false, observationOnly: true};
}

/** Integrity checking only: no DTO/file can authenticate a new physical owner or atomic store state. */
export function validateWireBacklogCapture(bytes, expected) {
    need(Buffer.isBuffer(bytes) && bytes.length <= wireBacklogCaptureLimits.maximumBytes, 'Capture file byte bound');
    need(expected && expected.bytes === bytes.length && /^[0-9a-f]{64}$/.test(expected.sha256)
        && hash(bytes) === expected.sha256, 'Externally pinned capture bytes required');
    const value = JSON.parse(bytes.toString());
    need(value.schemaVersion === 1 && value.kind === 'wire-backlog-evidence' && value.observationOnly === true
        && value.restorable === false && value.settlementAuthority === false && Array.isArray(value.rows)
        && value.rows.length <= wireBacklogCaptureLimits.maximumRows && value.omitted === 0 && value.failures === 0,
    'Incomplete or malformed backlog capture');
    need(typeof value.captureId === 'string' && /^[0-9a-f-]{36}$/.test(value.captureId)
        && value.identity && /^hyp-p191-[0-9a-f]{12}$/.test(value.identity.chain)
        && /^[0-9a-f]{40}$/.test(value.identity.sourceHead) && /^[0-9a-f]{64}$/.test(value.identity.configurationSha256),
    'Malformed capture identity');
    for (const name of Object.keys(wireBacklogCaptureLimits)) need(Number.isSafeInteger(value.limits?.[name])
        && value.limits[name] > 0 && value.limits[name] <= wireBacklogCaptureLimits[name], 'Malformed capture limits');
    need(value.rows.length <= value.limits.maximumRows && bytes.length <= value.limits.maximumBytes, 'Capture aggregate bound');
    let sequence = 0;
    let retainedBytes = 0;
    for (const row of value.rows) {
        need(row.sequence === ++sequence && /^[0-9]+$/.test(row.monotonicNs) && typeof row.kind === 'string', 'Capture row chronology');
        const fields = decodeWireBacklogValue(row.value, value.limits);
        if (row.body) {
            need(Number.isSafeInteger(row.body.bytes) && row.body.bytes >= 0 && row.body.bytes <= value.limits.maximumBodyBytes
                && typeof row.body.base64 === 'string' && row.body.base64.length <= 4 * Math.ceil(row.body.bytes / 3), 'Capture body identity');
            const body = Buffer.from(row.body.base64, 'base64');
            need(body.toString('base64') === row.body.base64 && body.length === row.body.bytes && hash(body) === row.body.sha256, 'Capture body hash differs');
        }
        if (fields.queue) need(fields.queue.startsWith(value.identity.chain + ':'), 'Foreign capture queue');
        retainedBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    }
    need(retainedBytes === value.retainedBytes, 'Capture retained byte count differs');
    return {capturedBytesIntact: true, restorable: false, missing: [...missing], originalPhysicalOwnersAreObservationOnly: true};
}
export function requireWireBacklogRestore(bytes, expected) {
    const result = validateWireBacklogCapture(bytes, expected);
    throw new Error('Backlog restore refused: ' + result.missing.join(', '));
}
