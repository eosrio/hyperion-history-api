/** Qualification-only accounting. No cache, transport options, proof decisions or result substitution. */
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';

export class LatencyHistogram {
    count = 0;
    totalNs = 0n;
    minimumNs = null;
    maximumNs = 0n;
    buckets = Array(64).fill(0);
    add(nanoseconds) {
        assert.ok(typeof nanoseconds === 'bigint' && nanoseconds >= 0n);
        this.count++; this.totalNs += nanoseconds;
        this.minimumNs = this.minimumNs === null || nanoseconds < this.minimumNs ? nanoseconds : this.minimumNs;
        if (nanoseconds > this.maximumNs) this.maximumNs = nanoseconds;
        const bucket = Math.min(63, nanoseconds === 0n ? 0 : nanoseconds.toString(2).length);
        this.buckets[bucket]++;
    }
    snapshot() {
        return {count: this.count, totalNs: String(this.totalNs), minimumNs: this.minimumNs === null ? null : String(this.minimumNs),
            maximumNs: String(this.maximumNs), buckets: [...this.buckets]};
    }
}

export class ObserverIoMetrics {
    writeLatency = new LatencyHistogram();
    syncLatency = new LatencyHistogram();
    attemptedBytes = 0;
    writtenBytes = 0;
    writeFailures = 0;
    syncFailures = 0;
    write(bytes, operation) {
        this.attemptedBytes += bytes;
        const start = process.hrtime.bigint();
        try {const result = operation(); this.writtenBytes += result; return result;}
        catch (error) {this.writeFailures++; throw error;}
        finally {this.writeLatency.add(process.hrtime.bigint() - start);}
    }
    sync(operation) {
        const start = process.hrtime.bigint();
        try {return operation();}
        catch (error) {this.syncFailures++; throw error;}
        finally {this.syncLatency.add(process.hrtime.bigint() - start);}
    }
    snapshot() {
        return {attemptedBytes: this.attemptedBytes, writtenBytes: this.writtenBytes,
            writeFailures: this.writeFailures, syncFailures: this.syncFailures,
            writeElapsed: this.writeLatency.snapshot(), syncElapsed: this.syncLatency.snapshot()};
    }
}

const installed = new WeakSet();
export function installProofMetrics({ProofReader, BundleStore, Connection, record}) {
    assert.ok(!installed.has(ProofReader), 'proof metrics already installed');
    // Refuse an incompatible installed dependency before touching any prototype.
    for (const [prototype, names] of [[ProofReader.prototype, ['open', 'authority', 'validateCommit']],
        [BundleStore.prototype, ['get', 'read']], [Connection.prototype, ['request']]])
        for (const name of names) assert.equal(typeof prototype[name], 'function', `missing observation seam ${name}`);
    const context = new AsyncLocalStorage(), restores = [];
    let nextId = 0, started = 0, settled = 0, reportFailures = 0;
    const emit = (event, value) => {
        // A full/broken observer must fail qualification, without masking the production result/error.
        try {record(event, value);} catch {reportFailures++;}
    };
    const patch = (prototype, name, wrap) => {
        const original = prototype[name]; assert.equal(typeof original, 'function', `missing observation seam ${name}`);
        const replacement = wrap(original); prototype[name] = replacement;
        restores.push(() => {assert.equal(prototype[name], replacement); prototype[name] = original;});
    };
    const histogram = (scope, name) => scope.timings[name] ??= new LatencyHistogram();
    const snapshot = scope => ({openId: scope.id, source: scope.source, selectionId: scope.selectionId,
        firstAuthority: scope.firstAuthority, lastAuthority: scope.lastAuthority,
        outcome: scope.outcome, openElapsedNs: scope.openElapsedNs, operationsInFlight: scope.inFlight,
        immutableGets: scope.immutableGets, bundleReads: scope.bundleReads, commitValidationCalls: scope.commitValidationCalls,
        stageFailures: {...scope.stageFailures},
        httpGetAttempts: scope.httpGetAttempts, httpCompleted: scope.httpCompleted, httpErrors: scope.httpErrors,
        httpNonSuccess: scope.httpNonSuccess, compressedBodyBytes: scope.compressedBodyBytes,
        utf8ReencodedBodyBytes: scope.utf8ReencodedBodyBytes, unknownBodySizes: scope.unknownBodySizes,
        timings: Object.fromEntries(Object.entries(scope.timings).map(([name, value]) => [name, value.snapshot()]))});
    const asyncStage = (prototype, name, counter, inspect) => patch(prototype, name, original => async function (...args) {
        const scope = context.getStore(); if (!scope) return original.apply(this, args);
        const start = process.hrtime.bigint(); scope.inFlight++; if (counter) scope[counter]++;
        let outcome = 'returned';
        try {const result = await original.apply(this, args); inspect?.(scope, result, args); return result;}
        catch (error) {scope.stageFailures[name] = (scope.stageFailures[name] ?? 0) + 1;
            outcome = typeof error?.code === 'string' ? error.code : 'threw'; throw error;}
        finally {
            const elapsedNs = process.hrtime.bigint() - start;
            histogram(scope, name).add(elapsedNs); scope.inFlight--;
            if (scope.closed) emit('proof_open_late_operation', {openId: scope.id, stage: name, outcome,
                elapsedNs: String(elapsedNs), accounting: snapshot(scope)});
        }
    });
    patch(ProofReader.prototype, 'open', original => async function (...args) {
        const source = args[0], start = process.hrtime.bigint(); started++;
        const scope = {id: ++nextId, source: {chainId: source?.chainId, blockNum: source?.blockNum, blockId: source?.blockId},
            selectionId: args[1], firstAuthority: null, lastAuthority: null, closed: false, inFlight: 0,
            immutableGets: 0, bundleReads: 0, commitValidationCalls: 0, httpGetAttempts: 0, httpCompleted: 0,
            httpErrors: 0, httpNonSuccess: 0, compressedBodyBytes: 0, utf8ReencodedBodyBytes: 0, unknownBodySizes: 0,
            timings: {}, stageFailures: {}, outcome: 'returned', openElapsedNs: null};
        return context.run(scope, async () => {
            try {return await original.apply(this, args);}
            catch (error) {scope.outcome = typeof error?.code === 'string' ? error.code : 'threw'; throw error;}
            finally {
                scope.closed = true; settled++; scope.openElapsedNs = String(process.hrtime.bigint() - start);
                emit('proof_open_finished', snapshot(scope));
            }
        });
    });
    asyncStage(ProofReader.prototype, 'authority', null, (scope, value) => {
        const authority = {generation: value.generation, headBlockNum: value.head.blockNum, headBlockId: value.head.blockId};
        scope.firstAuthority ??= authority; scope.lastAuthority = authority;
    });
    patch(ProofReader.prototype, 'validateCommit', original => function (...args) {
        const scope = context.getStore(); if (!scope) return original.apply(this, args);
        const start = process.hrtime.bigint(); scope.commitValidationCalls++;
        try {return original.apply(this, args);}
        catch (error) {scope.stageFailures.validateCommit = (scope.stageFailures.validateCommit ?? 0) + 1; throw error;}
        finally {histogram(scope, 'validateCommit').add(process.hrtime.bigint() - start);}
    });
    asyncStage(BundleStore.prototype, 'get', 'immutableGets');
    asyncStage(BundleStore.prototype, 'read', 'bundleReads');
    patch(Connection.prototype, 'request', original => async function (params, ...args) {
        const scope = context.getStore();
        if (!scope || params.method !== 'GET') return original.call(this, params, ...args);
        const start = process.hrtime.bigint(); scope.inFlight++; scope.httpGetAttempts++;
        try {
            const result = await original.call(this, params, ...args); scope.httpCompleted++;
            if (result.statusCode < 200 || result.statusCode >= 300) scope.httpNonSuccess++;
            // The installed UndiciConnection returns compressed/binary buffers or UTF-8-decoded strings.
            // Do not JSON.stringify the parsed document and call that a wire-byte measurement.
            const encoding = String(result.headers?.['content-encoding'] ?? '').toLowerCase();
            if (Buffer.isBuffer(result.body) && /gzip|deflate/.test(encoding)) scope.compressedBodyBytes += result.body.length;
            else if (typeof result.body === 'string') scope.utf8ReencodedBodyBytes += Buffer.byteLength(result.body);
            else scope.unknownBodySizes++;
            return result;
        } catch (error) {scope.httpErrors++; scope.unknownBodySizes++; throw error;}
        finally {
            const elapsedNs = process.hrtime.bigint() - start;
            histogram(scope, 'connectionRequest').add(elapsedNs); scope.inFlight--;
            if (scope.closed) emit('proof_open_late_operation', {openId: scope.id, stage: 'connectionRequest',
                elapsedNs: String(elapsedNs), accounting: snapshot(scope)});
        }
    });
    installed.add(ProofReader);
    return {snapshot: () => ({started, settled, reportFailures}),
        restore() {for (const restore of restores.reverse()) restore(); installed.delete(ProofReader);}};
}
