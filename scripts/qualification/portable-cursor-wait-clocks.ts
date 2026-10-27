/** In-memory qualification observations only; these clocks never issue or extend a wait. */
import {performance} from 'node:perf_hooks';

export interface PortableCursorWaitTarget {readonly blockNum: number; readonly blockId: string}
interface CursorWaitPhase {
    attempt: number; target: PortableCursorWaitTarget; startedMs: number; deadlineMs: number;
    completedMs: number | null; status: 'pending' | 'passed' | 'failed';
}
export const portableCursorWaitClockLimits = Object.freeze({maximumRecords: 128});

export function createPortableCursorWaitClocks() {
    const evidence = {schemaVersion: 1,
        clock: {kind: 'performance.now', pid: process.pid, processTimeOriginMs: performance.timeOrigin},
        limits: portableCursorWaitClockLimits, attempts: 0, omittedRecords: 0, records: [] as CursorWaitPhase[]};
    return {evidence,
        begin(target: PortableCursorWaitTarget, startedMs: number, deadlineMs: number): CursorWaitPhase {
            const phase: CursorWaitPhase = {attempt: ++evidence.attempts,
                target: {blockNum: target.blockNum, blockId: target.blockId}, startedMs, deadlineMs, completedMs: null, status: 'pending'};
            if (evidence.records.length === evidence.limits.maximumRecords) {evidence.records.shift(); evidence.omittedRecords++;}
            evidence.records.push(phase); return phase;
        },
        complete(phase: CursorWaitPhase, status: 'passed' | 'failed', completedMs: number) {
            phase.completedMs = completedMs; phase.status = status;
        }};
}
