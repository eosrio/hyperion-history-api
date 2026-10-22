import {describe, expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createProjectionValidationObserver, installProjectionValidationHooks, installProjectionPhaseRelay} from '../../scripts/qualification/projection-validation-observer.mjs';
import {assertProjectionMeasurementReport} from '../../scripts/qualification/projection-validation-phase.mjs';

const identity = {pid: 123, parentPid: 100, role: 'projection', node: 'v24.19.0'};
const phase = (name: string, id = name) => ({event: 'qualifier_projection_phase', requestId: id, phase: name});
function target() {
    return {
        validate: (value: unknown) => value,
        metadata: {findOne: async () => ({undo: []})},
        client: {startSession: () => ({startTransaction() {}, async commitTransaction() {}, async abortTransaction() {}})},
        async transaction(operation: () => unknown) {return operation();},
        async initialize() {}, async open(..._args: unknown[]) {}, async recovery() {}, async retainedCheckpoints() {},
        async markIncomplete() {}, async apply() {}, async rollback() {}, async query() {},
    };
}

describe('qualification projection observation', () => {
    test('forwards identical receiver and untouched arguments and returns the actual original Promise', async () => {
        const observer = createProjectionValidationObserver({identity});
        const adapter = target();
        const result = Object.freeze({exact: true}), pending = Promise.resolve(result);
        const argument = Object.defineProperty({}, 'binding', {get() {throw new Error('observer inspected input');}});
        let received: unknown[] = [], receiver: unknown;
        adapter.open = function (...args: unknown[]) {received = args; receiver = this; return pending as any;};
        observer.attachAdapter(adapter, 'owner');
        await observer.handlePhase(phase('prefix'));
        const actual = adapter.open(argument, result);
        expect(actual).toBe(pending); expect(receiver).toBe(adapter);
        expect(received[0]).toBe(argument); expect(received[1]).toBe(result);
        expect(await actual).toBe(result);
        const report = observer.report();
        expect(report.spans).toHaveLength(1); expect(report.spans[0].name).toBe('open');
        expect(report.spans[0].outcome).toBe('fulfilled'); expect(report.errors).toEqual([]);
    });

    test('keeps original synchronous throw and rejected Promise reasons, including already rejected promises', async () => {
        const observer = createProjectionValidationObserver({identity}), adapter = target();
        const failure = Object.freeze({original: true}), rejected = Promise.reject(failure);
        adapter.open = () => {throw failure;}; adapter.apply = () => rejected as any;
        observer.attachAdapter(adapter, 'owner');
        let thrown: unknown; try {adapter.open();} catch (error) {thrown = error;}
        expect(thrown).toBe(failure); const returned = adapter.apply(); expect(returned).toBe(rejected);
        try {await returned;} catch (error) {expect(error).toBe(failure);}
        expect(observer.report().spans.map((row: any) => row.outcome).sort()).toEqual(['rejected', 'threw']);
    });

    test('real-instance hooks attach before initialize and observe direct reads plus loaded validation', async () => {
        const observer = createProjectionValidationObserver({identity});
        class Storage {
            validate = (value: unknown) => value;
            metadata = {findOne: async (..._args: unknown[]) => ({undo: []})};
            client = target().client;
            async transaction(operation: () => unknown) {return operation();}
            async load(...args: unknown[]) {return this.validate(await this.metadata.findOne(...args));}
            async initialize() {await this.metadata.findOne({direct: true}); return this.load({captured: true});}
            async open() {return this.load({captured: true});}
            async recovery() {} async retainedCheckpoints() {} async markIncomplete() {} async apply() {} async rollback() {} async query() {}
        }
        class Controller {static create(options: {adapter: Storage}) {return options.adapter.initialize();}}
        const restore = installProjectionValidationHooks(observer, {Storage, Controller, role: 'projection'});
        try {
            const adapter = new Storage(); await Controller.create({adapter});
            const report = observer.report();
            expect(report.attachments).toHaveLength(1);
            expect(report.attachments[0].initialPublicOperationUnobserved).toBe(false);
            expect(report.spans.filter((row: any) => row.kind === 'operation').map((row: any) => row.name)).toEqual(['initialize']);
            expect(report.spans.filter((row: any) => row.kind === 'metadata-read')).toHaveLength(2);
            expect(report.spans.filter((row: any) => row.kind === 'validation')).toHaveLength(1);
            expect(report.spans.filter((row: any) => row.kind === 'load')).toHaveLength(1);
        } finally {observer.restore(); restore();}
    });

    test('API discovery records the initial open gap without fabricating a logical operation', async () => {
        const observer = createProjectionValidationObserver({identity: {...identity, role: 'api'}});
        class Storage {
            validate = (value: unknown) => value; metadata = {findOne: async () => ({undo: []})}; client = target().client;
            async transaction(operation: () => unknown) {return operation();}
            async load() {return this.validate(await this.metadata.findOne());}
            async open() {return this.load();}
            async initialize() {} async recovery() {} async retainedCheckpoints() {} async markIncomplete() {} async apply() {} async rollback() {} async query() {}
        }
        const restore = installProjectionValidationHooks(observer, {Storage, role: 'api'});
        try {
            const adapter = new Storage(); await adapter.open();
            expect(observer.report().attachments[0].initialPublicOperationUnobserved).toBe(true);
            expect(observer.report().spans.filter((row: any) => row.kind === 'operation')).toHaveLength(0);
            await adapter.open();
            expect(observer.report().spans.filter((row: any) => row.kind === 'operation')).toHaveLength(1);
        } finally {observer.restore(); restore();}
    });

    test('concurrent adapter calls keep their asynchronous descendants in separate logical roots', async () => {
        const observer = createProjectionValidationObserver({identity}), adapter = target();
        let first!: () => void, second!: () => void;
        const a = new Promise<void>(resolve => {first = resolve;}), b = new Promise<void>(resolve => {second = resolve;});
        adapter.open = async () => {await a; return adapter.validate({lane: 'open'}) as any;};
        adapter.apply = async () => {await b; return adapter.validate({lane: 'apply'}) as any;};
        observer.attachAdapter(adapter, 'owner');
        const one = adapter.open(), two = adapter.apply(); second(); await two; first(); await one;
        const report = observer.report(), roots = report.spans.filter((row: any) => row.kind === 'operation');
        for (const root of roots) {
            const child = report.spans.find((row: any) => row.kind === 'validation' && row.operationId === root.id);
            expect(child.rootId).toBe(root.id); expect(child.parentId).toBe(root.id); expect(child.operation).toBe(root.name);
        }
    });

    test('session instrumentation keeps native callbacks and options and separates body attempts from commit attempts', async () => {
        const observer = createProjectionValidationObserver({identity}), adapter = target();
        const transactionOptions = Object.freeze({readConcern: {level: 'snapshot'}, writeConcern: {w: 'majority', j: true}});
        const callback = async () => ({unchanged: true}); let receivedCallback: unknown, receivedOptions: unknown;
        const session = {startTransaction(..._args: unknown[]) {}, async commitTransaction() {}, async abortTransaction() {},
            async withTransaction(fn: typeof callback, options: unknown) {
                receivedCallback = fn; receivedOptions = options;
                this.startTransaction(options); await fn();
                this.startTransaction(options); const result = await fn();
                await this.commitTransaction(); await this.commitTransaction(); return result;
            }};
        adapter.client.startSession = () => session;
        adapter.transaction = function (operation: typeof callback) {
            const actual = this.client.startSession(); expect(actual).toBe(session);
            return session.withTransaction(operation, transactionOptions);
        } as any;
        observer.attachAdapter(adapter, 'owner');
        expect(await adapter.transaction(callback)).toEqual({unchanged: true});
        expect(receivedCallback).toBe(callback); expect(receivedOptions).toBe(transactionOptions);
        expect(observer.report().spans.filter((row: any) => row.kind === 'transaction-start' && row.outcome === 'returned')).toHaveLength(2);
        expect(observer.report().spans.filter((row: any) => row.kind === 'commit')).toHaveLength(2);
    });

    test('phase order and attachment are required, and identical requests are idempotent', async () => {
        const observer = createProjectionValidationObserver({identity, limits: {readinessTimeoutMS: 5}});
        expect((await observer.handlePhase(phase('prefix'))).error).toBeDefined();
        const valid = createProjectionValidationObserver({identity}); valid.attachAdapter(target(), 'owner');
        const first = valid.handlePhase(phase('prefix')); expect(valid.handlePhase(phase('prefix'))).toBe(first);
        expect((await first).attached).toBe(true); expect(valid.report().phases).toHaveLength(1);
        expect((await valid.handlePhase(phase('verification'))).error).toBeDefined();
        expect((await valid.handlePhase(phase('held-head', 'prefix'))).error).toBeDefined();
    });

    test('shutdown seals new root calls while retained descendants settle across phases', async () => {
        const observer = createProjectionValidationObserver({identity}), adapter = target();
        let resume!: () => void; const waiting = new Promise<void>(resolve => {resume = resolve;});
        adapter.apply = async () => {await waiting; return adapter.validate({stillTracked: true}) as any;};
        observer.attachAdapter(adapter, 'owner'); await observer.handlePhase(phase('prefix'));
        const pending = adapter.apply(); await observer.handlePhase(phase('held-head')); await observer.handlePhase(phase('verification'));
        const shutdown = observer.handlePhase(phase('shutdown'));
        await adapter.open(); resume(); await pending;
        expect((await shutdown).error).toBeUndefined();
        const report = observer.report(); expect(report.sealed).toBe(true); expect(report.inFlight).toEqual([]);
        expect(report.suppressedRootSpans).toBe(1);
        const apply = report.spans.find((row: any) => row.name === 'apply');
        expect(apply.startPhase).toBe('prefix'); expect(apply.endPhase).toBe('shutdown');
        expect(report.spans.find((row: any) => row.kind === 'validation').rootId).toBe(apply.id);
    });

    test('timeout, observer persistence failure and span overflow remain explicit failed measurements', async () => {
        const observer = createProjectionValidationObserver({identity, limits: {sealTimeoutMS: 2}, persist() {throw new Error('disk');}});
        const adapter = target(); adapter.apply = () => new Promise(() => {}); observer.attachAdapter(adapter, 'owner');
        for (const name of ['prefix', 'held-head', 'verification']) await observer.handlePhase(phase(name));
        void adapter.apply(); expect((await observer.handlePhase(phase('shutdown'))).error).toBeDefined();
        expect(observer.report().sealed).toBe(false); expect(observer.report().sealTimedOut).toBe(true);
        expect(observer.report().inFlight).toHaveLength(1);
        expect(observer.report().errors.map((row: any) => row.code)).toContain('persist-failed');
        const small = createProjectionValidationObserver({identity, limits: {maxSpans: 1}}), other = target(); small.attachAdapter(other, 'owner');
        await other.open(); await other.open(); expect(small.report().droppedSpans).toBe(1);
        expect(small.report().errors[0].code).toBe('span-budget');
    });

    test('sealing retains descendants of an existing child even after its root Promise settles', async () => {
        const observer = createProjectionValidationObserver({identity}), adapter = target();
        let resume!: () => void, child!: Promise<unknown>;
        const waiting = new Promise<void>(resolve => {resume = resolve;});
        adapter.open = () => {
            child = observer.observeLoad(adapter, async () => {await waiting; return adapter.validate({child: true});}, []);
            return Promise.resolve();
        };
        observer.attachAdapter(adapter, 'owner'); await observer.handlePhase(phase('prefix')); await adapter.open();
        await observer.handlePhase(phase('held-head')); await observer.handlePhase(phase('verification'));
        const shutdown = observer.handlePhase(phase('shutdown')); resume(); await child; await shutdown;
        expect(observer.report().spans.filter((row: any) => row.kind === 'validation')).toHaveLength(1);
        expect(observer.report().suppressedRootSpans).toBe(0);
    });

    test('a failed attachment restores earlier properties rather than partially changing the target', () => {
        const observer = createProjectionValidationObserver({identity}), adapter = target(), originalValidate = adapter.validate;
        Object.defineProperty(adapter, 'transaction', {value: adapter.transaction, writable: false, configurable: false});
        expect(observer.attachAdapter(adapter, 'owner')).toBe(false);
        expect(adapter.validate).toBe(originalValidate);
    });

    test('thenable and argument accessors are untouched by observation', () => {
        const observer = createProjectionValidationObserver({identity}), adapter = target();
        const result = Object.defineProperty({}, 'then', {get() {throw new Error('then getter touched');}});
        adapter.open = () => result as any; observer.attachAdapter(adapter, 'owner');
        expect(adapter.open()).toBe(result); expect(observer.report().spans[0].outcome).toBe('returned');
    });

    test('undo cardinality comes only from successful validated own data, with failures and accessors unavailable', () => {
        const observer = createProjectionValidationObserver({identity}), adapter = target();
        const valid = Object.freeze({undo: Object.freeze([{}, {}])}), failure = Object.freeze({failed: true});
        let selected: unknown = valid;
        adapter.validate = () => {if (selected === failure) throw failure; return selected;};
        observer.attachAdapter(adapter, 'owner');
        expect(adapter.validate(null)).toBe(valid);
        selected = Object.defineProperty({}, 'undo', {get() {throw new Error('getter must remain untouched');}});
        expect(adapter.validate(null)).toBe(selected);
        selected = new Proxy({}, {getOwnPropertyDescriptor() {throw new Error('proxy trap must remain untouched');}});
        expect(adapter.validate(null)).toBe(selected);
        selected = failure; let thrown: unknown; try {adapter.validate(null);} catch (error) {thrown = error;}
        expect(thrown).toBe(failure);
        const report = observer.report();
        expect(report.spans.map((row: any) => row.undoDescriptorCount)).toEqual([2, null, null, null]);
        expect(report.counters[0].undoDescriptorVisits).toBe(2);
        expect(report.counters[0].undoCardinalityAvailable).toBe(1);
        expect(report.counters[0].undoCardinalityUnavailable).toBe(3);
        expect(report.errors).toEqual([]);
    });

    test('session restoration has a hard limit and restores reachable own and inherited methods exactly', () => {
        const observer = createProjectionValidationObserver({identity, limits: {maxSessionHooks: 2}}), adapter = target();
        const prototype = {async commitTransaction() {}, async abortTransaction() {}};
        adapter.client.startSession = () => {
            const session = Object.create(prototype);
            Object.defineProperty(session, 'startTransaction', {value: () => session, writable: true, configurable: true, enumerable: true});
            session.original = Object.getOwnPropertyDescriptor(session, 'startTransaction');
            return session;
        };
        observer.attachAdapter(adapter, 'owner');
        const first = adapter.client.startSession(), second = adapter.client.startSession(), third = adapter.client.startSession();
        expect(first.startTransaction).not.toBe(first.original.value);
        expect(third.startTransaction).toBe(third.original.value);
        expect(Object.hasOwn(third, 'commitTransaction')).toBe(false);
        expect(observer.report().sessionHooks.weakReferenceSlots).toBe(2);
        expect(observer.report().sessionHooks.limitExceeded).toBe(1);
        expect(observer.report().errors.map((row: any) => row.code)).toContain('session-hook-budget');
        observer.restore();
        for (const session of [first, second]) {
            expect(Object.getOwnPropertyDescriptor(session, 'startTransaction')).toEqual(session.original);
            expect(Object.hasOwn(session, 'commitTransaction')).toBe(false);
            expect(session.commitTransaction).toBe(prototype.commitTransaction);
        }
    });

    test('suppressed starts create no new hooks but an existing tracked shutdown descendant remains observed', async () => {
        const bounded = createProjectionValidationObserver({identity, limits: {maxSpans: 1}}), ordinary = target();
        ordinary.client.startSession = () => {const session: any = {async commitTransaction() {}, async abortTransaction() {}};
            session.startTransaction = () => session; session.original = session.startTransaction; return session;};
        bounded.attachAdapter(ordinary, 'owner'); ordinary.client.startSession();
        const dropped: any = ordinary.client.startSession();
        expect(dropped.startTransaction).toBe(dropped.original);
        expect(bounded.report().sessionHooks.weakReferenceSlots).toBe(1);
        const observer = createProjectionValidationObserver({identity}), adapter = target();
        adapter.client.startSession = () => {const session: any = {async commitTransaction() {}, async abortTransaction() {}};
            session.startTransaction = () => session; session.original = session.startTransaction; return session;};
        let resume!: () => void; const waiting = new Promise<void>(resolve => {resume = resolve;});
        adapter.apply = async () => {await waiting; const session = adapter.client.startSession(); session.startTransaction();};
        observer.attachAdapter(adapter, 'owner'); await observer.handlePhase(phase('prefix'));
        const pending = adapter.apply(); await observer.handlePhase(phase('held-head')); await observer.handlePhase(phase('verification'));
        const shutdown = observer.handlePhase(phase('shutdown'));
        const untracked: any = adapter.client.startSession(); expect(untracked.startTransaction).toBe(untracked.original);
        resume(); await pending; await shutdown;
        expect(observer.report().sessionHooks.weakReferenceSlots).toBe(1);
        expect(observer.report().spans.filter((row: any) => row.kind === 'transaction-start')).toHaveLength(1);
        expect(observer.report().errors).toEqual([]);
    });

    test('a pending first prefix waits for actual attachment and duplicate requests share that wait', async () => {
        const observer = createProjectionValidationObserver({identity, limits: {readinessTimeoutMS: 100}});
        const pending = observer.handlePhase(phase('prefix'));
        expect(observer.handlePhase(phase('prefix'))).toBe(pending);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(observer.report().phases).toEqual([]); expect(observer.report().errors).toEqual([]);
        const adapter = target(); observer.attachAdapter(adapter, 'owner'); await adapter.open();
        expect((await pending).error).toBeUndefined(); expect(observer.report().phases).toHaveLength(1);
        expect(observer.report().spans[0].startPhase).toBe('startup');
    });

    test('pending prefix conflicts and bounded unattached timeout are explicit without advancing a phase', async () => {
        const timeout = createProjectionValidationObserver({identity, limits: {readinessTimeoutMS: 3}});
        expect((await timeout.handlePhase(phase('prefix'))).error).toBeDefined();
        expect(timeout.report().errors.map((row: any) => row.code)).toContain('readiness-timeout');
        expect(timeout.report().phases).toEqual([]);
        timeout.attachAdapter(target(), 'owner');
        expect((await timeout.handlePhase(phase('prefix'))).error).toBeDefined();
        expect(timeout.report().phases).toEqual([]);
        const conflict = createProjectionValidationObserver({identity, limits: {readinessTimeoutMS: 100}});
        const pending = conflict.handlePhase(phase('prefix'));
        expect((await conflict.handlePhase(phase('prefix', 'different-request'))).error).toBeDefined();
        expect(conflict.handlePhase(phase('prefix'))).toBe(pending);
        expect((await conflict.handlePhase(phase('held-head', 'prefix'))).error).toBeDefined();
        expect((await conflict.handlePhase(phase('held-head'))).error).toBeDefined();
        expect(conflict.report().phases).toEqual([]);
        conflict.attachAdapter(target(), 'owner'); await pending;
        expect(conflict.report().phases).toHaveLength(1);
        expect(() => createProjectionValidationObserver({identity, limits: {readinessTimeoutMS: 5001}})).toThrow();
    });

    test('master relays the actual sender identity and rejects forged or unsent phase ACKs', () => {
        const sent: unknown[] = [], delivered: unknown[] = [];
        const parent = Object.assign(new EventEmitter(), {pid: 100, send(message: unknown) {delivered.push(message); return false;}});
        const worker = Object.assign(new EventEmitter(), {process: {pid: 123}, isConnected: () => true,
            send(message: unknown) {sent.push(message); return false;}});
        const children = Object.assign(new EventEmitter(), {workers: {one: worker}});
        const restore = installProjectionPhaseRelay(parent, children);
        try {
            parent.emit('message', phase('prefix'));
            expect(sent).toEqual([phase('prefix')]);
            const ack = {event: 'qualifier_projection_phase_ack', requestId: 'prefix', phase: 'prefix',
                pid: 123, parentPid: 100, role: 'projection', attached: true};
            worker.emit('message', {...ack, pid: 999}); worker.emit('message', {...ack, requestId: 'unsent'});
            expect(delivered).toEqual([]);
            worker.emit('message', ack); expect(delivered).toEqual([{...ack, viaParentPid: 100}]);
            parent.emit('message', phase('held-head', 'prefix'));
            expect(sent).toHaveLength(1);
        } finally {restore();}
        expect(parent.listenerCount('message')).toBe(0); expect(worker.listenerCount('message')).toBe(0);
    });

    const nativeNode = process.env.HYPERION_NATIVE_NODE ?? process.env.HYP252_NATIVE_NODE ?? 'node';
    let nativeVersion = '';
    try {nativeVersion = execFileSync(nativeNode, ['--version'], {encoding: 'utf8', timeout: 5000}).trim();} catch {}
    const helper = new URL('../../scripts/qualification/projection-validation-observer.mjs', import.meta.url).href;
    test.skipIf(!/^v(?:22|24)\./.test(nativeVersion))('native forced GC releases both hooked and suppressed self-referencing sessions before restoration', () => {
        const script = `
            import assert from 'node:assert/strict';
            import {createProjectionValidationObserver} from ${JSON.stringify(helper)};
            const cases=[];
            for(const suppressed of [true,false]) {
                const observer=createProjectionValidationObserver({identity:{pid:process.pid,parentPid:process.ppid,role:'projection',node:process.version},
                    ...(suppressed?{limits:{maxSpans:1}}:{})});
                const adapter={validate:value=>value,metadata:{findOne(){}},transaction(){},client:{startSession(){
                    const session={}; session.startTransaction=()=>session; session.commitTransaction=async()=>session; session.abortTransaction=async()=>session;
                    return session;}}};
                for(const name of ['initialize','open','recovery','retainedCheckpoints','markIncomplete','apply','rollback','query']) adapter[name]=()=>{};
                observer.attachAdapter(adapter,'owner'); const references=[];
                for(let index=0;index<1000;index++) references.push(new WeakRef(adapter.client.startSession()));
                const before=observer.report();
                assert.equal(before.sessionHooks.weakReferenceSlots,suppressed?1:1000);
                assert.equal(before.spans.length,suppressed?1:1000);assert.equal(before.droppedSpans,suppressed?999:0);
                for(let cycle=0;cycle<12;cycle++) {await new Promise(setImmediate); global.gc(); await new Promise(setImmediate);}
                const alive=references.filter(reference=>reference.deref()).length;
                assert.equal(alive,0,'Ended sessions remain alive before restore');
                cases.push({suppressed,aliveBeforeRestore:alive,weakReferenceSlots:before.sessionHooks.weakReferenceSlots}); observer.restore();
            }
            console.log(JSON.stringify({node:process.version,cases}));`;
        const result = JSON.parse(execFileSync(nativeNode, ['--expose-gc', '--input-type=module', '-e', script], {
            encoding: 'utf8', timeout: 10000, env: {...process.env, NODE_OPTIONS: '', HYP252_OBSERVER_DIR: ''},
        }).trim());
        expect(result.cases).toEqual([{suppressed: true, aliveBeforeRestore: 0, weakReferenceSlots: 1},
            {suppressed: false, aliveBeforeRestore: 0, weakReferenceSlots: 1000}]);
    });
    test.skipIf(!/^v(?:22|24)\./.test(nativeVersion))('native preload observes actual controller/adapter modules and produces the independently accepted sealed receipt', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hyperion-projection-observer-'));
        const fixture = new URL('../../packages/backend-mongodb/tests/fixture.mjs', import.meta.url).href;
        const backend = new URL('../../packages/backend-mongodb/dist/index.js', import.meta.url).href;
        const controller = new URL('../../build/indexer/projection/controller.js', import.meta.url).href;
        const bindingModule = new URL('../../build/indexer/projection/config.js', import.meta.url).href;
        const script = `
            import assert from 'node:assert/strict';
            import {databaseFixture,definition,binding} from ${JSON.stringify(fixture)};
            import {createMongoDbRecoveryAdapter} from ${JSON.stringify(backend)};
            import {PortableStateController} from ${JSON.stringify(controller)};
            import {portableStateBinding} from ${JSON.stringify(bindingModule)};
            const fixture=databaseFixture(), configuration={backend:{id:binding.backendId,database:'fixture'},projections:[definition],finality:'reversible'};
            const adapter=createMongoDbRecoveryAdapter({client:fixture.client,databaseName:'fixture',backendId:binding.backendId});
            await PortableStateController.create({chainId:binding.chainId,configuration,adapter,
                source:{frame(){throw Error('unused')},revalidate(){throw Error('unused')},planRecovery(){throw Error('unused')},revalidateRecovery(){throw Error('unused')}}});
            const selected=portableStateBinding(configuration,definition,binding.chainId), acks=[];
            process.send=message=>{acks.push(message);return true};
            async function phase(name) {
                const requestId='native-'+name, before=acks.length;
                process.emit('message',{event:'qualifier_projection_phase',requestId,phase:name});
                const until=Date.now()+2000;
                while(acks.length===before&&Date.now()<until) await new Promise(resolve=>setTimeout(resolve,1));
                assert.equal(acks.length,before+1); assert.equal(acks.at(-1).error,undefined);
            }
            await phase('prefix'); await Promise.all([adapter.open(selected),adapter.recovery(selected)]);
            await phase('held-head'); await adapter.retainedCheckpoints({binding:selected,revision:(await adapter.open(selected)).revision});
            await phase('verification'); await phase('shutdown');
            console.log(JSON.stringify({pid:process.pid,acks}));`;
        try {
            const output = execFileSync(nativeNode, ['--import', helper, '--input-type=module', '-e', script], {
                encoding: 'utf8', timeout: 10000, env: {...process.env, NODE_OPTIONS: '', NODE_PATH: '', worker_role: 'projection', HYP252_OBSERVER_DIR: directory},
            });
            const capture = JSON.parse(output.trim());
            expect(readdirSync(directory)).toEqual([`projection-${capture.pid}.json`]);
            const value = JSON.parse(readFileSync(join(directory, `projection-${capture.pid}.json`), 'utf8'));
            const storage = fileURLToPath(new URL('../../packages/backend-mongodb/dist/storage.js', import.meta.url));
            const digest = createHash('sha256').update(readFileSync(storage)).digest('hex');
            const receipts = capture.acks.map((acknowledgment: any) => ({phase: acknowledgment.phase, receipts: [{acknowledgment}]}));
            const result = assertProjectionMeasurementReport(value, {pid: capture.pid, parentPid: process.pid, role: 'projection'}, receipts, digest);
            expect(result.sealed).toBe(true); expect(value.node).toBe(nativeVersion);
            expect(value.spans.some((row: any) => row.kind === 'validation')).toBe(true);
            unlinkSync(join(directory, `projection-${capture.pid}.json`)); rmdirSync(directory);
        } catch (error) {throw new Error(`Native observer evidence retained at ${directory}`, {cause: error});}
    });

    test.skipIf(!nativeVersion)('disabled native import leaves production methods unchanged and its provided output directory empty', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hyperion-projection-observer-off-'));
        const storage = new URL('../../packages/backend-mongodb/dist/storage.js', import.meta.url).href;
        const script = `import assert from 'node:assert/strict';import {MongoProjectionStorage} from ${JSON.stringify(storage)};
            const before=MongoProjectionStorage.prototype.load; await import(${JSON.stringify(helper)});
            assert.equal(MongoProjectionStorage.prototype.load,before); console.log('disabled');`;
        expect(execFileSync(nativeNode, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 10000,
            env: {...process.env, NODE_OPTIONS: '', HYP252_OBSERVER_DIR: ''}}).trim()).toBe('disabled');
        expect(readdirSync(directory)).toEqual([]); rmdirSync(directory);
    });
});
