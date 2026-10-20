/** Internal admission qualification only: loaded after harness ownership/source audits, before the real launcher. */
import {HyperionWorker} from '../../build/indexer/workers/hyperionWorker.js';
import {isAbsolute} from 'node:path';
import {statSync} from 'node:fs';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readActionSourceCrashControl, actionSourceCrashSnapshot, deliberatelyExitActionSource,
    createActionSourceAckRecorder} from './action-source-admission-fault.mjs';
const directory = process.env.ES198_OBSERVER_DIR;
if (!directory || !isAbsolute(directory) || !statSync(directory).isDirectory()) throw new Error('Admission qualifier requires its owned output directory');
Object.defineProperty(HyperionWorker.prototype, 'actionSourceAdmissionEnabled', {get() {return true;}, configurable: false});

// Only the guarded retained-fixture launcher writes this control. Ordinary admission runs have no fault hooks.
const controlFile = process.env.ES198_ACTION_CRASH_CONTROL;
if (controlFile) {
    const control = readActionSourceCrashControl(controlFile, {observerDirectory: directory,
        chain: process.env.CHAIN_NAME, configFile: process.env.CONFIG_JSON});
    if (process.env.worker_role === 'ds_pool_worker') {
        const {default: DSPoolWorker} = await import('../../build/indexer/workers/ds-pool.js');
        const {ActionSourceAdmissionStore} = await import('../../build/indexer/history/action-source-admission.js');
        const active = new AsyncLocalStorage(), wrappedChannels = new WeakSet();
        const recordAck = createActionSourceAckRecorder(control);
        const messages = DSPoolWorker.prototype.processMessages;
        const begin = DSPoolWorker.prototype.beginActionAdmission;
        const prepare = ActionSourceAdmissionStore.prototype.prepareTransaction;
        assert.equal(typeof begin, 'function'); assert.equal(typeof messages, 'function'); assert.equal(typeof prepare, 'function');
        DSPoolWorker.prototype.processMessages = function (...args) {
            assert.equal(this.chain, control.chain); assert.equal(this.protocolId, 'antelope');
            return active.run({worker: this, message: undefined}, () => messages.apply(this, args));
        };
        DSPoolWorker.prototype.beginActionAdmission = async function (message, ...args) {
            const result = await begin.call(this, message, ...args), context = active.getStore();
            assert.equal(context?.worker, this); context.message = message;
            const channel = this.activeActionAdmission.owner.consumer;
            if (!wrappedChannels.has(channel)) {
                wrappedChannels.add(channel); const ack = channel.ack;
                channel.ack = function (delivery, ...ackArgs) {
                    const current = active.getStore(); assert.ok(current?.worker && current.message === delivery);
                    assert.equal(current.worker.activeActionAdmission.owner.consumer, this);
                    const snapshot = actionSourceCrashSnapshot(current.worker, delivery);
                    deliberatelyExitActionSource(control, 'before-ack', snapshot);
                    recordAck('ack-intent', snapshot);
                    const acknowledged = ack.call(this, delivery, ...ackArgs);
                    recordAck('ack-sent', snapshot);
                    return acknowledged;
                };
            }
            return result;
        };
        ActionSourceAdmissionStore.prototype.prepareTransaction = async function (...args) {
            const context = active.getStore(); assert.ok(context?.worker && context.message);
            const scope = context.worker.activeActionAdmission;
            assert.equal(args[0], scope.admission); assert.equal(args[1], scope.traceOrdinal);
            assert.ok(Buffer.from(args[2]).equals(scope.payload));
            deliberatelyExitActionSource(control, 'before-fragment', actionSourceCrashSnapshot(context.worker, context.message, null));
            const result = await prepare.apply(this, args);
            deliberatelyExitActionSource(control, 'after-fragment', actionSourceCrashSnapshot(context.worker, context.message, result.fragmentId));
            return result;
        };
    }
}
