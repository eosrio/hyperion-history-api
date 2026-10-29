import {expect, test} from 'bun:test';
import {setImmediate as turn} from 'node:timers/promises';
import {StatefulApiProbeClient, StatefulWorkerProbeBroker} from '../../src/indexer/projection/stateful-control.js';
const target = 'a'.repeat(64);
test('API probe refuses wrong socket/nonce/target and cannot transfer a reply across reconnect', async () => {
    const sent: any[] = [], first = {readyState: 1, send(bytes: string, callback: any) {sent.push(JSON.parse(bytes)); callback();}};
    let current = first;
    const client = new StatefulApiProbeClient(1, 1000, () => current), signal = new AbortController();
    const work = client.probe(target, signal.signal), message = sent[0]; let settled = false; void work.then(() => {settled = true;});
    expect(await client.probe(target, signal.signal)).toBe(false); // Explicit concurrent budget.
    const reply = {...message, event: 'stateful_owner_probe_reply', current: true};
    client.accept({...first}, JSON.stringify(reply));
    client.accept(first, JSON.stringify({...reply, requestId: 'foreign'}));
    client.accept(first, JSON.stringify({...reply, target: 'b'.repeat(64)})); await turn(); expect(settled).toBe(false);
    current = {...first}; client.accept(first, JSON.stringify(reply)); expect(await work).toBe(false);
    const second = client.probe(target, signal.signal), next = sent[1];
    client.accept(current, JSON.stringify(reply)); await turn();
    client.accept(current, JSON.stringify({...reply, requestId: next.requestId})); expect(await second).toBe(true);
    const aborted = client.probe(target, signal.signal); signal.abort(); expect(await aborted).toBe(false);
});
test('master probe binds the exact worker and rechecks retirement after a correct reply', async () => {
    const sent: any[] = [], worker = {send(message: unknown, callback: any) {sent.push(message); callback(null);}};
    let active = true;
    const broker = new StatefulWorkerProbeBroker(1, 1000, candidate => candidate === worker && active);
    const work = broker.probe(worker, target), request = sent[0].data; let settled = false; void work.then(() => {settled = true;});
    expect(await broker.probe(worker, target)).toBe(false);
    broker.accept({...worker}, {...request, current: true}); broker.accept(worker, {...request, target: 'b'.repeat(64), current: true});
    await turn(); expect(settled).toBe(false);
    active = false; broker.accept(worker, {...request, current: true}); expect(await work).toBe(false);
    active = true; const next = broker.probe(worker, target); broker.retired(worker); expect(await next).toBe(false);
});
