/** Qualification-only coherent Mongo sampling. Never changes adapter or serving semantics. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openSync, writeFileSync, fsyncSync, closeSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {BSON} from 'mongodb';
import {setTimeout as pause} from 'node:timers/promises';
import type {ProjectionRecoveryView} from '@eosrio/hyperion-sdk/projection';
import {auditPortablePhysicalMongo, isPortableMongoAdmissionTransition, portableMongoAdmissionReason, portableMongoError,
    type PortableMongoAuditInput, type PortableMongoPhysicalSample} from './portable-state-worker-mongo.ts';

export const portableMongoSamplingLimits = Object.freeze({maximumRecords: 64, maximumRecordBytes: 8 * 1024 * 1024,
    maximumCapturedBytes: 64 * 1024 * 1024});
const stable = (value: any): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
    : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value);
const same = (actual: unknown, expected: unknown, label: string) => assert.equal(stable(actual), stable(expected), label);
const withoutReason = (value: ProjectionRecoveryView) => ({binding: value.binding, checkpoint: value.checkpoint,
    initialized: value.initialized, gap: value.gap, pending: value.pending && {...value.pending, reason: null}});
export interface PortableMongoIsolationSample {
    schemaVersion: number; attempt: number; through: number; deadline: number; started: number; completed?: number;
    logical?: ProjectionRecoveryView; api?: any; physical?: PortableMongoPhysicalSample;
    outcome: string; retryable: boolean; error?: unknown;
}
/** Exclusive complete records; exhaustion/serialization/write failures stop qualification visibly. */
export function createPortableMongoSamples(directory: string) {
    mkdirSync(directory, {recursive: true});
    const evidence = {schemaVersion: 1, limits: portableMongoSamplingLimits, attempts: 0, capturedBytes: 0,
        rejected: 0, accepted: 0, failedCaptures: 0, captureError: undefined as unknown,
        records: [] as {attempt: number; file: string; bytes: number; sha256: string; outcome: string}[]};
    return {evidence, record(sample: PortableMongoIsolationSample) {
        const attempt = ++evidence.attempts;
        try {
            assert.ok(attempt <= portableMongoSamplingLimits.maximumRecords, 'physical Mongo sample record budget exhausted');
            const bytes = Buffer.from(JSON.stringify(BSON.EJSON.serialize({...sample, captureAttempt: attempt})) + '\n');
            assert.ok(bytes.length <= portableMongoSamplingLimits.maximumRecordBytes, 'physical Mongo sample record byte budget exhausted');
            assert.ok(evidence.capturedBytes + bytes.length <= portableMongoSamplingLimits.maximumCapturedBytes,
                'physical Mongo sample total byte budget exhausted');
            const file = `${String(attempt).padStart(3, '0')}-physical-mongo.json`, fd = openSync(join(directory, file), 'wx');
            try {writeFileSync(fd, bytes); fsyncSync(fd);} finally {closeSync(fd);}
            evidence.capturedBytes += bytes.length;
            sample.outcome === 'passed' ? evidence.accepted++ : evidence.rejected++;
            evidence.records.push({attempt, file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), outcome: sample.outcome});
        } catch (error) {evidence.failedCaptures++; evidence.captureError = portableMongoError(error); throw error;}
    }};
}

/** Only the original isolation phase supplies this deadline; no per-sample timeout window is created. */
export async function samplePortableMongoIsolation(options: {input: PortableMongoAuditInput; budget: {readonly deadline: number};
    recovery: (operationTimeoutMS: number) => Promise<ProjectionRecoveryView>; query: (budget: {readonly deadline: number}) => Promise<any>;
    capture: (sample: PortableMongoIsolationSample) => void; guard: () => void;
    now?: () => number; sleep?: (milliseconds: number) => Promise<unknown>}) {
    const now = options.now ?? (() => performance.now()), sleep = options.sleep ?? pause;
    const {input, budget} = options;
    assert.ok(Number.isFinite(budget.deadline), 'physical Mongo sampling requires the original isolation deadline');
    const failed = input.expectations.filter(value => value.failedBlock); assert.equal(failed.length, 1);
    const expected = failed[0];
    const remaining = () => {const value = Math.floor(budget.deadline - now());
        assert.ok(value > 0, 'physical Mongo inherited isolation deadline exceeded'); return value;};
    let attempt = 0;
    for (;;) {
        remaining();
        const sample: PortableMongoIsolationSample = {schemaVersion: 1, attempt: ++attempt, through: input.through,
            deadline: budget.deadline, started: now(), outcome: 'started', retryable: false};
        let result: Awaited<ReturnType<typeof auditPortablePhysicalMongo>> | undefined, failure: unknown, rejected = false;
        try {
            options.guard();
            const recovery = await options.recovery(Math.min(5000, remaining())); sample.logical = structuredClone(recovery); remaining();
            same(recovery.binding, expected.binding, 'logical Mongo binding/generation differs');
            same(recovery.checkpoint, expected.checkpoint, 'logical Mongo checkpoint differs');
            assert.equal(recovery.initialized, true); assert.equal(recovery.gap, null);
            same(recovery.pending?.block, expected.failedBlock, 'logical Mongo failed source differs');
            assert.equal(recovery.pending?.digest, null); assert.equal(typeof recovery.pending?.reason, 'string');
            assert.ok(Buffer.byteLength(recovery.pending!.reason!) <= 4096);
            const reason = recovery.pending!.reason!;
            if (reason !== portableMongoAdmissionReason) assert.match(reason, /Required source field is missing/);
            sample.api = await options.query(budget); remaining();
            assert.equal(sample.api.status, 503); assert.equal(sample.api.body.retryable, true);
            assert.equal(sample.api.headers['retry-after'], '1');
            for (const field of ['hyperion-state-block-num', 'hyperion-state-block-id', 'hyperion-state-last-valid']) assert.equal(sample.api.headers[field], undefined);
            assert.equal(sample.api.body.view, undefined); assert.equal(sample.api.body.rows, undefined);
            let physicalError: unknown, physicalRejected = false;
            try {result = await auditPortablePhysicalMongo(input, {budget, now, capture: value => {sample.physical = value;}});}
            catch (error) {physicalRejected = true; physicalError = error;}
            options.guard(); remaining();
            if (physicalRejected && !isPortableMongoAdmissionTransition(physicalError, sample.physical)) throw physicalError;
            assert.equal(sample.physical?.complete, true);
            const stored = sample.physical!.observations.metadataSnapshot.find((value: any) => value.binding.projectionId === expected.binding.projectionId);
            assert.ok(stored);
            same(withoutReason(recovery), withoutReason(stored), 'logical/physical Mongo source or invariant differs');
            const physicalReason = stored.pending.reason;
            const reasonTransition = reason === portableMongoAdmissionReason || physicalReason === portableMongoAdmissionReason || physicalRejected;
            if (!reasonTransition) same(reason, physicalReason, 'logical/physical Mongo reason changed outside admission transition');
            if (reasonTransition) {
                sample.outcome = 'admission-transition'; sample.retryable = true;
                sample.error = physicalRejected ? portableMongoError(physicalError) : {message: 'Exact same-source logical/physical admission reason transition'};
            } else {assert.ok(result); sample.outcome = 'passed';}
        } catch (error) {rejected = true; failure = error; sample.outcome = 'fatal'; sample.error = portableMongoError(error);}
        sample.completed = now();
        options.capture(sample); // An incomplete capture is fatal, even when the physical predicate was transient.
        if (rejected) throw failure;
        remaining();
        if (sample.outcome === 'passed') return {physical: result!, isolation: {through: input.through, recovery: sample.logical!, api: sample.api}};
        assert.equal(sample.retryable, true);
        await sleep(Math.min(100, remaining()));
    }
}
