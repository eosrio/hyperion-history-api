/** Controlled service transport only; production stores/proofs and native IPC remain active. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';

export function fixtureWorkerTransport(endpoint = process, observe) {
    const pending = new Map();
    const receive = message => {
        if (message?.event !== 'qualification_service_reply') return;
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.value);
        else {
            const error = new Error(message.error.message);
            for (const field of ['name', 'code', 'statusCode', 'meta']) if (message.error[field] !== undefined) error[field] = message.error[field];
            entry.reject(error);
        }
    };
    endpoint.on('message', receive);
    function request(kind, body, options) {
        assert(pending.size < 32, 'Controlled service transport request bound');
        let scope;
        try {scope = currentProofConsumerScope();} catch {}
        const diagnostic = {scope: scope?.snapshot() ?? null, signalPassed: !!options?.signal};
        return new Promise((resolve, reject) => {
            const id = randomUUID(), timer = setTimeout(() => {
                if (pending.delete(id)) reject(new Error('Controlled service transport did not settle original request'));
            }, 30_000);
            pending.set(id, {resolve, reject, timer});
            observe?.({id, kind, body, scope, diagnostic});
            endpoint.send({event: 'qualification_service_request', id, kind, body, diagnostic}, error => {
                if (!error || !pending.delete(id)) return;
                clearTimeout(timer); reject(error);
            });
        });
    }
    const client = {}, indices = {};
    for (const method of ['create', 'index', 'get', 'search'])
        client[method] = (body, options) => request('es', {method, body}, options);
    for (const method of ['create', 'getMapping', 'getSettings', 'exists'])
        indices[method] = (body, options) => request('es', {method: 'indices.' + method, body}, options);
    client.indices = indices;
    class Consumer extends EventEmitter {
        acked = []; streamed = [];
        ack(message) {
            this.acked.push(message);
            endpoint.send({event: 'qualification_ack', deliveryTag: message.fields.deliveryTag,
                headers: message.properties.headers});
        }
        publish(exchange, queue, payload, options) {
            this.streamed.push({exchange, queue, bytes: payload.length});
            endpoint.send({event: 'qualification_stream', exchange, queue, bytes: payload.length});
            return true;
        }
    }
    class Publisher extends EventEmitter {
        sent = [];
        sendToQueue(queue, payload, options, confirm) {
            const body = {queue, payloadHex: Buffer.from(payload).toString('hex'), options: structuredClone(options)};
            this.sent.push(body);
            request('publish', body).then(() => confirm?.(null), error => confirm?.(error));
            return true;
        }
    }
    return {client, Consumer, Publisher, request,
        pendingCount: () => pending.size,
        close() {assert.equal(pending.size, 0, 'Controlled IO remains physically pending'); endpoint.off('message', receive);}};
}

export async function dispatchFixtureService(worker, message, memory, publish, before, after) {
    if (message?.event !== 'qualification_service_request') return false;
    try {
        await before?.(worker, message);
        let value;
        if (message.kind === 'es') {
            const {method, body} = message.body;
            if (method.startsWith('indices.')) {
                const name = method.slice(8);
                assert(['create', 'getMapping', 'getSettings', 'exists'].includes(name));
                value = await memory.client.indices[name](body);
            } else {
                assert(['create', 'index', 'get', 'search'].includes(method));
                assert.equal(typeof memory.client[method], 'function', 'Unexpected ES request family');
                value = await memory.client[method](body);
            }
        } else {
            assert.equal(message.kind, 'publish');
            value = await publish(worker, message.body);
        }
        if (after) value = await after(worker, message, value);
        worker.send({event: 'qualification_service_reply', id: message.id, ok: true, value}, () => {});
    } catch (error) {
        worker.send({event: 'qualification_service_reply', id: message.id, ok: false,
                    error: {name: error.name, message: error.message, code: error.code, statusCode: error.statusCode, meta: error.meta}}, () => {});
    }
    return true;
}
