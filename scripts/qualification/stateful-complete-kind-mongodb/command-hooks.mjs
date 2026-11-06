// Qualification-only fault/cancellation gates. No server or process lifecycle operations.
import assert from 'node:assert/strict';

export function installCompleteKindCommandHooks(client, database, {beforeData, afterData}) {
    const topology = client.topology;
    assert.equal(typeof topology?.selectServer, 'function', 'Connect the bounded client before installing qualification gates');
    assert.ok(typeof database === 'string' && database.length > 0);
    assert.equal(typeof beforeData, 'function'); assert.equal(typeof afterData, 'function');
    const restores = new Map(), selectServer = topology.selectServer;
    let active = true;
    const replace = (target, name, wrapper) => {
        const original = Object.getOwnPropertyDescriptor(target, name);
        Object.defineProperty(target, name, {configurable: true, writable: true, enumerable: original?.enumerable ?? false, value: wrapper});
        return () => {
            if (target[name] !== wrapper) return; // Do not replace a later independent wrapper.
            if (original) Object.defineProperty(target, name, original); else delete target[name];
        };
    };
    const restoreSelection = replace(topology, 'selectServer', async function (...args) {
        const server = await Reflect.apply(selectServer, this, args);
        if (!active || this !== topology) return server;
        assert.equal(server.topology, topology, 'The selected server must belong to this bounded client');
        if (!restores.has(server)) {
            const command = server.command; assert.equal(typeof command, 'function');
            restores.set(server, replace(server, 'command', async function (...args) {
                const [operation] = args, session = operation?.session;
                // Reading RunCommandOperation.command avoids buildCommand side effects on metadata/batched operations.
                const input = operation?.commandName === 'runCommand' ? operation.command : undefined;
                const tagged = active && this === server && client.topology === topology && session?.client === client
                    && operation.ns?.db === database && input?.comment?.hyperion === 'stateful-complete-kind-v1'
                    && (input.find !== undefined || input.getMore !== undefined);
                if (!tagged) return Reflect.apply(command, this, args);
                await beforeData(input);
                assert.equal(operation.session, session); assert.equal(session.client, client); assert.equal(operation.command, input);
                const response = await Reflect.apply(command, this, args);
                await afterData(input, response);
                return response;
            }));
        }
        return server;
    });
    return () => {
        if (!active) return; active = false; restoreSelection();
        for (const restore of restores.values()) restore(); restores.clear();
    };
}
