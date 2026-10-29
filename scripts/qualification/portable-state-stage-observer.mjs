/** Opt-in qualification observations. Original promises, callbacks, errors and ownership remain authoritative. */
import {isPromise} from 'node:util/types';

export function installPortableStageObserver({Controller, Runtime, currentScope, record, maximumRecords = 20000, maximumBytes = 4 * 1024 * 1024}) {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1024)
        throw new Error('Invalid stage observer bounds');
    let records = 0, bytes = 0, omitted = 0, filtered = 0, failures = 0, sequence = 0, nextScope = 0;
    const scopes = new WeakMap(), restores = [], wrapped = new WeakMap();
    const scopeContext = () => {try {const scope = currentScope(); return scope && scopes.get(scope);} catch {return undefined;}};
    const emit = (stage, state, fields = {}) => {
        try {
            const context = {...scopeContext(), ...fields};
            if (!Number.isSafeInteger(context.blockNum) || context.blockNum < 1200 || context.blockNum > 1480) {filtered++; return;}
            const row = {stage, state, sequence: ++sequence, monotonicNs: process.hrtime.bigint().toString(), ...context};
            const size = Buffer.byteLength(JSON.stringify(row));
            if (records >= maximumRecords || bytes + size > maximumBytes) {omitted++; return;}
            record('portable_stage', row); records++; bytes += size;
        } catch {failures++;}
    };
    const fields = (projectionId, blockNum) => ({projectionId: typeof projectionId === 'string' ? projectionId.slice(0, 128) : null,
        blockNum: Number.isSafeInteger(blockNum) ? blockNum : null});
    const watch = (stage, context, invoke) => {
        context = {...scopeContext(), ...context};
        emit(stage, 'enter', context);
        let result;
        try {result = invoke();} catch (error) {emit(stage, 'error', context); throw error;}
        try {
            if (!isPromise(result)) {emit(stage, 'return', context); return result;}
            Promise.prototype.then.call(result, () => emit(stage, 'return', context), error => {
                let state = 'error'; try {if (error?.code === 'worker_attempt_fenced' || error?.name === 'AbortError') state = 'cancel';} catch {failures++;}
                emit(stage, state, context);
            });
        } catch {failures++;}
        return result;
    };
    // Own descriptors are restored exactly. Unsupported surfaces count as failed observation; they never alter the original call.
    const patch = (object, name, make) => {
        try {
            let names = wrapped.get(object); if (names?.has(name)) return;
            const original = object[name]; if (typeof original !== 'function') {failures++; return;}
            const descriptor = Object.getOwnPropertyDescriptor(object, name), replacement = make(original);
            if (descriptor && (!('value' in descriptor) || (!descriptor.writable && !descriptor.configurable))) {failures++; return;}
            Object.defineProperty(object, name, descriptor ? {...descriptor, value: replacement} : {value: replacement, writable: true, configurable: true, enumerable: false});
            if (!names) {names = new Set(); wrapped.set(object, names);} names.add(name);
            restores.push(() => {if (Object.getOwnPropertyDescriptor(object, name)?.value !== replacement) {failures++; return;}
                if (descriptor) Object.defineProperty(object, name, descriptor); else delete object[name];});
        } catch {failures++;}
    };
    patch(Controller, 'create', create => function(options, ...rest) {
        try {
            const source = options.source, adapter = options.adapter;
            patch(source, 'frame', frame => function(blockNum, definition, admit, ...args) {
                const context = fields(definition?.id, blockNum);
                try {const scope = currentScope(); if (scope) {context.diagnosticScopeId = ++nextScope; scopes.set(scope, context);}} catch {failures++;}
                const observedAdmit = typeof admit === 'function' ? function(block, ...more) {
                    return watch('admission', context, () => admit.call(this, block, ...more));
                } : admit;
                return watch('source.frame', context, () => frame.call(this, blockNum, definition, observedAdmit, ...args));
            });
            patch(source, 'revalidate', revalidate => function(...args) {return watch('proof.revalidate', {}, () => revalidate.apply(this, args));});
            patch(adapter, 'markIncomplete', mark => function(binding, block, ...args) {
                return watch('marker', fields(binding?.projectionId, block?.blockNum), () => mark.call(this, binding, block, ...args));
            });
            patch(adapter, 'apply', apply => function(request, ...args) {
                return watch('adapter.apply', fields(request?.binding?.projectionId, request?.block?.blockNum), () => apply.call(this, request, ...args));
            });
        } catch {failures++;}
        return create.call(this, options, ...rest);
    });
    patch(Runtime.prototype, 'process', runtimeProcess => function(frame, ...args) {
        return watch('runtime.process', fields(this.binding?.projectionId, frame?.block?.blockNum), () => runtimeProcess.call(this, frame, ...args));
    });
    return {snapshot: () => ({records, bytes, omitted, filtered, failures}), restore() {
        for (const restore of restores.reverse()) {try {restore();} catch {failures++;}}
        restores.length = 0;
    }};
}
