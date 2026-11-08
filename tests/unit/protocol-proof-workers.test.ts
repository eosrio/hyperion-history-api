import {expect, test} from 'bun:test';
import {freeProtocolProofWorkers, protectProtocolActions} from '../../src/api/helpers/protocol-abi.js';

const host = (provider: string) => ({manager: {config: {settings: {protocol: {provider}}}}}) as any;
// Raw history without decoded data needs no ABI authority, so each proof returns at once.
const actions = (count: number) => Array.from({length: count}, (_, index) => ({index, act: {account: 'alpha', name: 'act'}}));

test('prepares every action once in hit order and returns its shared workers', async () => {
    for (const provider of ['extension', 'antelope']) {
        const seen: number[] = [], list = actions(10);
        await protectProtocolActions(host(provider), {}, list, {}, action => seen.push(action.index));
        expect(seen).toEqual(list.map(action => action.index));
        expect(freeProtocolProofWorkers()).toBe(3);
    }
});

test('concurrent requests never take more than the shared extra workers', async () => {
    const before = freeProtocolProofWorkers(), lows: number[] = [];
    await Promise.all([0, 1, 2].map(() => protectProtocolActions(host('extension'), {}, actions(6), {},
        () => lows.push(freeProtocolProofWorkers()))));
    expect(Math.min(...lows)).toBeGreaterThanOrEqual(0);
    expect(freeProtocolProofWorkers()).toBe(before);
});

test('the first failure rejects, stops new actions and still returns its shared workers', async () => {
    const seen: number[] = [], failure = new Error('stop');
    await expect(protectProtocolActions(host('extension'), {}, actions(50), {}, action => {
        seen.push(action.index); if (action.index === 2) throw failure;
    })).rejects.toBe(failure);
    expect(seen.length).toBeLessThan(10);
    expect(freeProtocolProofWorkers()).toBe(3);
});
