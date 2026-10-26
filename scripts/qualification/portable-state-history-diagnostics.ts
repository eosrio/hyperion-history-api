/** Qualification evidence only. Observations never retry, validate or replace the observed operation. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {digest} from './contract-fixture.ts';

export const portableHistoryClockDomain = Object.freeze({kind: 'process.hrtime.bigint', pid: process.pid,
    processTimeOriginMs: performance.timeOrigin});
export const portableHistoryClock = () => ({monotonicNs: process.hrtime.bigint().toString(), wallTimeMs: Date.now()});
export const portableHistoryDiagnosticLimits = Object.freeze({maximumRecords: 128,
    maximumRecordBytes: 16 * 1024 * 1024, maximumCapturedBytes: 64 * 1024 * 1024});

const errorSnapshot = (error: any) => error instanceof Error ? {name: error.name, message: error.message,
    stack: error.stack, code: (error as any).code, statusCode: (error as any).meta?.statusCode,
    response: (error as any).meta?.body} : {thrown: error};

export function createPortableHistoryDiagnostics(directory: string, errors: string[]) {
    const evidence = {schemaVersion: 1, clock: portableHistoryClockDomain, limits: portableHistoryDiagnosticLimits,
        attempts: 0, capturedBytes: 0, failedCaptures: 0, records: [] as {attempt: number; file: string; bytes: number; sha256: string}[]};
    let reservedBytes = 0;
    const failed = (error: unknown) => {
        evidence.failedCaptures++;
        let detail = 'unprintable capture error'; try {detail = String(error).slice(0, 1024);} catch {}
        if (evidence.failedCaptures === 1) errors.push('Native history diagnostic capture incomplete: ' + detail);
    };
    return {evidence,
        async observe<T>(kind: 'action-search' | 'action-refresh', context: unknown, work: () => Promise<T>): Promise<T> {
            const attempt = ++evidence.attempts;
            // Detach the request and phase before invoking client code, which may mutate its arguments.
            let contextJson: string | undefined;
            try {contextJson = JSON.stringify(context); assert.ok(contextJson !== undefined);} catch (error) {failed(error);}
            const started = portableHistoryClock(); let response: T | undefined, operationError: unknown, rejected = false;
            try {response = await work();} catch (error) {rejected = true; operationError = error;}
            const completed = portableHistoryClock();
            if (contextJson !== undefined) try {
                assert.ok(['action-search', 'action-refresh'].includes(kind), 'unknown history diagnostic operation');
                assert.ok(attempt <= evidence.limits.maximumRecords, 'history diagnostic record budget exceeded');
                const bytes = Buffer.from(JSON.stringify({schemaVersion: 1, attempt, kind, clock: portableHistoryClockDomain,
                    started, completed, context: JSON.parse(contextJson), outcome: rejected ? 'rejected' : 'returned',
                    ...(rejected ? {error: errorSnapshot(operationError)} : {response, returnedUndefined: response === undefined})}) + '\n');
                assert.ok(bytes.length <= evidence.limits.maximumRecordBytes, 'history diagnostic record byte budget exceeded');
                assert.ok(reservedBytes + bytes.length <= evidence.limits.maximumCapturedBytes, 'history diagnostic total byte budget exceeded');
                reservedBytes += bytes.length;
                const file = `${String(attempt).padStart(3, '0')}-${kind}.json`;
                await writeFile(join(directory, file), bytes, {flag: 'wx'});
                evidence.capturedBytes += bytes.length; evidence.records.push({attempt, file, bytes: bytes.length, sha256: digest(bytes)});
            } catch (error) {failed(error);}
            if (rejected) throw operationError;
            return response as T;
        }};
}
export type PortableHistoryDiagnostics = ReturnType<typeof createPortableHistoryDiagnostics>;
