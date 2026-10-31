#!/usr/bin/env node
/** #403 source-only engineering comparison. No services, serving grants or physical throughput claim. */
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture, plan, invalid} from '../../tests/fixtures/portable-mapping-retry-controller.mjs';
import {originalWireRows} from '../../tests/fixtures/portable-mapping-retry.mjs';

assert(['24', '26'].includes(process.versions.node.split('.')[0]), 'Use the required native Node24/26 runtime');
const withDueArrival = process.argv.length === 3 && process.argv[2] === '--with-due-arrival';
assert(process.argv.length === 2 || withDueArrival, 'Only the fixed --with-due-arrival schedule may be selected');
const offered = [0, 100, 200, 300, 400, 1100, ...(withDueArrival ? [2100] : [])];
const elapsed = start => Number(process.hrtime.bigint() - start) / 1e6;

async function run(interval) {
    const original = await originalWireRows();
    let value, arrivals = [];
    try {
        value = await fixture(original, interval);
        const pulses = [], offeredArrivals = [], started = process.hrtime.bigint(), clockStart = performance.now();
        // Input availability is offered independently from the awaited shared drain. A slow drain
        // cannot postpone a later arrival; actual callback lateness remains explicit below.
        arrivals = offered.map((at, index) => (async () => {
            await delay(Math.max(0, at - elapsed(started)));
            const through = 1243 + 8 * (index + 1); original.releaseThrough(through);
            offeredArrivals.push({plannedMs: at, actualMs: elapsed(started), through});
        })());
        for (const [index, arrival] of arrivals.entries()) {
            await arrival;
            const before = {...value.counts}, begunMs = elapsed(started);
            await value.controller.drain();
            for (const definition of plan.definitions)
                assert.equal(value.metadata.get(definition.id).checkpoint.blockNum, 1243 + 8 * (index + 1));
            assert.equal(value.metadata.get(invalid.id).checkpoint.blockNum, 1243);
            assert.equal(value.metadata.get(invalid.id).pending.block.blockNum, 1244);
            pulses.push({plannedMs: offered[index], begunMs, endedMs: elapsed(started), counts: {...value.counts},
                delta: Object.fromEntries(Object.entries(value.counts).map(([key, count]) => [key, count - before[key]]))});
        }
        const result = {intervalMs: interval ?? 0, elapsedMs: elapsed(started), offeredArrivals, pulses,
            counts: {...value.counts}, healthy: plan.definitions.map(definition => value.metadata.get(definition.id).checkpoint.blockNum),
            invalidCheckpoint: value.metadata.get(invalid.id).checkpoint, invalidPending: value.metadata.get(invalid.id).pending,
            invalidPreparations: value.calls.filter(call => call.projectionId === invalid.id), attempts: value.attempts.length,
            successfulFailureMarkerMs: value.failureMarkers.map(value => value.at - clockStart),
            invalidPreparationStartMs: value.invalidSourceStarts.map(value => value - clockStart)};
        assert.equal(result.counts.apply, offered.length * 16); assert.equal(result.attempts, offered.length * 17);
        result.retryAfterMarkerMs = result.invalidPreparationStartMs.slice(1).map((at, index) => at - result.successfulFailureMarkerMs[index]);
        if (interval) assert(result.retryAfterMarkerMs.every(value => value >= interval), 'every repeated preparation is actually due after the prior durable marker');
        return result;
    } finally {
        await Promise.allSettled(arrivals);
        await value?.controller.stop(); await original.dispose();
    }
}

const start = process.hrtime.bigint(), pairs = [];
for (let pair = 0; pair < 5; pair++) {
    const order = pair % 2 ? [1000, undefined] : [undefined, 1000], results = [];
    for (const interval of order) results.push(await run(interval));
    const baseline = results.find(value => value.intervalMs === 0), candidate = results.find(value => value.intervalMs === 1000);
    assert.equal(baseline.invalidPreparations.length, offered.length);
    assert(candidate.invalidPreparations.length >= 1 && candidate.invalidPreparations.length <= offered.length);
    assert.deepEqual(candidate.healthy, baseline.healthy);
    assert(candidate.invalidPreparations.every(value => value.height === 1244));
    pairs.push({pair, order: order.map(value => value ?? 0), baseline, candidate});
    console.log(JSON.stringify({kind: 'pair', node: process.version, ...pairs.at(-1)}));
}
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({kind: 'summary', node: process.version, pairs: pairs.length, productionDefaultMs: 0,
    engineeringIntervalMs: 1000, offeredMs: offered, elapsedMs: elapsed(start),
    invalidPreparations: {baseline: pairs.map(value => value.baseline.invalidPreparations.length), candidate: pairs.map(value => value.candidate.invalidPreparations.length)},
    actualDueRetryObserved: pairs.map(value => value.candidate.retryAfterMarkerMs.length > 0),
    controlledWindowMedianMs: {baseline: median(pairs.map(value => value.baseline.elapsedMs)), candidate: median(pairs.map(value => value.candidate.elapsedMs))},
    scope: 'current emitted controller/runtime default0 versus1000 and retained Wire ABI/rows; controlled source and adapter ports; no production policy activation',
    unmeasured: ['physical ES/Mongo/HTTP replay', 'CPU samples', 'allocation/GC', 'OS/native I/O', 'integrated throughput gain']}));
