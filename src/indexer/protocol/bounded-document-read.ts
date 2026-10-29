import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {unzipSync} from 'node:zlib';
import type {Client} from '@elastic/elasticsearch';
import {Transport, type GetConnectionOptions, type TransportOptions} from '@elastic/transport';

/** The pinned transport inflates compressed responses before its JSON serializer without an output cap. */
async function boundedResponse(reply: any, deserialize: (text: string) => unknown, maximumResponseBytes: number, label: string, signal?: AbortSignal): Promise<unknown> {
    const body = reply?.body;
    if (!(body instanceof Readable)) throw new Error('Invalid ' + label.toLowerCase() + ' stream');
    const settled = finished(body, {cleanup: true}); void settled.catch(() => {});
    const abort = () => body.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Membership hint aborted'));
    let completed = false;
    signal?.addEventListener('abort', abort, {once: true});
    try {
        signal?.throwIfAborted();
        if (reply.statusCode !== 200) throw new Error(`${label} HTTP failure`, {cause: {statusCode: reply.statusCode}});
        const type = reply.headers?.['content-type'], encoding = reply.headers?.['content-encoding'] ?? '';
        if (typeof type !== 'string' || type.length > 256 || !/^application\/(?:json|vnd\.elasticsearch\+json)(?:\s*;|$)/i.test(type)
            || typeof encoding !== 'string' || encoding.length > 32 || !['', 'identity', 'gzip', 'deflate'].includes(encoding.toLowerCase()))
            throw new Error('Invalid ' + label.toLowerCase() + ' content headers');
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of body) {
            signal?.throwIfAborted();
            if (!(chunk instanceof Uint8Array)) throw new Error('Invalid ' + label.toLowerCase() + ' byte chunk');
            bytes += chunk.byteLength;
            if (bytes > maximumResponseBytes) throw new Error(`${label} wire byte bound exceeded`);
            chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
        signal?.throwIfAborted();
        const wire = Buffer.concat(chunks, bytes);
        const decoded = ['gzip', 'deflate'].includes(encoding.toLowerCase())
            ? unzipSync(wire, {maxOutputLength: maximumResponseBytes}) : wire;
        if (decoded.length > maximumResponseBytes) throw new Error(`${label} decoded byte bound exceeded`);
        const result = deserialize(decoded.toString('utf8')); completed = true;
        return result;
    } finally {
        signal?.removeEventListener('abort', abort);
        if (!body.destroyed) body.destroy();
        let failure: unknown;
        try {await settled;} catch (error) {failure = error;}
        if (completed) {signal?.throwIfAborted(); if (failure) throw failure;}
    }
}

/** Capture before the SDK product check can reject and hide an acquired live body. */
export async function ownedBoundedProtocolMget(client: Client, index: string, ids: string[], source: boolean, maximumResponseBytes: number, label: string, signal?: AbortSignal): Promise<unknown> {
    if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1 || maximumResponseBytes > 2 * 1024 * 1024)
        throw new Error('Invalid bounded protocol read response limit');
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 256 || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,512}$/.test(id))
        || Buffer.byteLength(JSON.stringify({ids})) > 64 * 1024)
        throw new Error('Invalid bounded protocol read request');
    const acquired = new Map<Readable, Promise<void>>(), originals = new WeakMap<object, object>();
    const ParentTransport = client.transport.constructor as typeof Transport;
    class HintTransport extends ParentTransport {
        constructor(options: TransportOptions) {
            const pool = options.connectionPool;
            const localPool = new Proxy(pool, {get(target, key) {
                const value = Reflect.get(target, key, target);
                if (key === 'markAlive' || key === 'markDead') return (connection: object) =>
                    value.call(target, originals.get(connection) ?? connection);
                return typeof value === 'function' ? value.bind(target) : value;
            }});
            // The parent remains the pool's configured maintenance owner; do not start duplicate sniff work.
            super({...options, connectionPool: localPool, sniffOnStart: false, sniffInterval: false, sniffOnConnectionFault: false});
        }
        getConnection(options: GetConnectionOptions) {
            const connection = super.getConnection(options); if (connection === null) return null;
            const facade = new Proxy(connection, {get(target, key) {
                if (key === 'request') return async (...args: Parameters<typeof connection.request>) => {
                    const reply = await Reflect.apply(connection.request, connection, args);
                    if (reply.body instanceof Readable && !acquired.has(reply.body)) {
                        const settled = finished(reply.body, {cleanup: true}); void settled.catch(() => {});
                        acquired.set(reply.body, settled);
                    }
                    return reply;
                };
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }});
            originals.set(facade, connection); return facade;
        }
    }
    // A child shares the original pool/auth/TLS configuration; never close that shared pool here.
    const child = client.child({Transport: HintTransport});
    let completed = false;
    try {
        const reply = await child.mget({index, ids, realtime: true, _source: source},
            {signal, asStream: true, meta: true, maxResponseSize: maximumResponseBytes,
                maxCompressedResponseSize: maximumResponseBytes});
        const result = await boundedResponse(reply, text => child.serializer.deserialize(text), maximumResponseBytes, label, signal); completed = true; return result;
    } finally {
        for (const body of acquired.keys()) if (!body.destroyed) body.destroy();
        await Promise.allSettled(acquired.values());
        if (completed) signal?.throwIfAborted();
    }
}

