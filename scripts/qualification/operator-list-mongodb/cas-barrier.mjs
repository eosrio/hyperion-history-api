// Qualification-only transport scheduling. The real selected server/driver executes unchanged commands.
import assert from 'node:assert/strict';
export function installPublicationBarrier(client, database, expected, revisions) {
    const topology = client.topology, pending = new Set(revisions), arrived = new Set(), restores = new Map();
    assert.ok(topology && typeof topology.selectServer === 'function' && pending.size === 2);
    let release, active = true; const ready = new Promise(resolve => {release = resolve;});
    const replace = (target, key, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(target, key); Object.defineProperty(target, key, {configurable: true, writable: true, value});
        return () => {if (target[key] !== value) return; if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key];};
    };
    const select = topology.selectServer;
    const restoreSelect = replace(topology, 'selectServer', async function (...args) {
        const server = await Reflect.apply(select, this, args); if (!active || this !== topology) return server;
        assert.equal(server.topology, topology);
        if (!restores.has(server)) {
            const execute = server.command;
            restores.set(server, replace(server, 'command', async function (...values) {
                const [operation] = values, command = operation?.commandName === 'runCommand' ? operation.command : null;
                const update = command?.update === 'bounded_ol_v1_source' ? command.updates?.[0] : null;
                const selected = update?.u?.revision;
                if (active && this === server && operation.ns.db === database && operation.session?.client === client
                    && update?.q?.revision === expected && pending.has(selected)) {
                    assert.equal(arrived.has(selected), false, 'A publication CAS attempted replay'); arrived.add(selected);
                    if (arrived.size === 2) release();
                    const signal = operation.options.signal; assert.ok(signal instanceof AbortSignal); signal.throwIfAborted();
                    await new Promise((resolve, reject) => {
                        const abort = () => {signal.removeEventListener('abort', abort); reject(signal.reason);};
                        signal.addEventListener('abort', abort, {once: true});
                        ready.then(() => {signal.removeEventListener('abort', abort); resolve();});
                    });
                    signal.throwIfAborted();
                }
                return Reflect.apply(execute, this, values);
            }));
        }
        return server;
    });
    return {arrived, close() {active = false; restoreSelect(); for (const restore of restores.values()) restore(); restores.clear();}};
}
