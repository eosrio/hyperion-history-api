/** Qualification only: observe an actual successful majority rollback intent, then stop its
 * exact projection process for independent physical/API inspection and parent-owned SIGKILL. */
import {MongoClient} from 'mongodb';
import {existsSync, readFileSync, writeFileSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

export function rollbackIntentReceipt(event, database, metadataId) {
    const command = event?.command;
    if (event?.databaseName !== database || event.commandName !== 'findAndModify'
        || command?.findAndModify !== 'h45_projection_metadata' || command?.query?._id !== metadataId) return undefined;
    const state = command.update?.$set?.rollback;
    if (!state || state.status !== 'running' || typeof command.update.$set.revision !== 'string') return undefined;
    if (command.writeConcern?.w !== 'majority' || command.writeConcern?.j !== true)
        throw new Error('Qualification rollback intent lacks its actual majority+journal concern');
    return {operationId: state.operationId, sourceRevision: state.sourceRevision, from: state.from, ancestor: state.ancestor,
        revision: command.update.$set.revision, writeConcern: {w: command.writeConcern.w, j: command.writeConcern.j}};
}

if (process.env.worker_role === 'projection' && process.env.HYP246_RECOVERY_OBSERVER) {
    if (process.platform !== 'linux' || !/^(22|24)\./.test(process.versions.node)) throw new Error('Recovery crash observer requires native Linux Node22/24');
    const argument = process.env.HYP246_RECOVERY_OBSERVER;
    if (!isAbsolute(argument) || realpathSync(argument) !== argument || !statSync(argument).isDirectory())
        throw new Error('Recovery observer needs an existing ordinary absolute directory');
    const directory = argument, seen = new WeakSet(), originalConnect = MongoClient.prototype.connect;
    MongoClient.prototype.connect = function (...args) {
        if (!seen.has(this)) {
            seen.add(this); this.monitorCommands = true;
            const requests = new Map();
            this.on('commandStarted', event => {
                const arm = join(directory, 'arm.json');
                if (!existsSync(arm) || existsSync(join(directory, 'barrier.json'))) return;
                const input = readFileSync(arm); if (input.length > 4096) throw new Error('Recovery observer arm exceeds bound');
                const selected = JSON.parse(input);
                if (!/^h45_p191_[0-9a-f]{12}$/.test(selected.database) || !/^[a-f0-9]{64}$/.test(selected.metadataId))
                    throw new Error('Recovery observer arm is outside the owned fixture');
                const receipt = rollbackIntentReceipt(event, selected.database, selected.metadataId);
                if (receipt) {if (requests.size >= 8) throw new Error('Recovery observer request budget exceeded'); requests.set(event.requestId, receipt);}
            });
            this.on('commandFailed', event => requests.delete(event.requestId));
            this.on('commandSucceeded', event => {
                const receipt = requests.get(event.requestId); if (!receipt) return; requests.delete(event.requestId);
                if (event.reply?.ok !== 1 || event.reply?.writeConcernError || event.reply?.writeErrors?.length
                    || !event.reply?.value || event.reply.value.rollback?.operationId !== receipt.operationId) return;
                const output = {schemaVersion: 1, pid: process.pid, parentPid: process.ppid, role: process.env.worker_role,
                    node: process.version, observedAt: new Date().toISOString(), requestId: event.requestId, receipt,
                    note: 'Actual Mongo commandSucceeded with majority+journal concern; SIGSTOP before adapter undo starts.'};
                try {writeFileSync(join(directory, 'barrier.json'), JSON.stringify(output, null, 2) + '\n', {flag: 'wx'});}
                catch (error) {if (error.code === 'EEXIST') return; throw error;}
                process.kill(process.pid, 'SIGSTOP');
            });
        }
        return Reflect.apply(originalConnect, this, args);
    };
}
