import {writeSync} from 'node:fs';
import {assertNativeQualificationRuntime} from './native-node-runtime.mjs';
import {fileURLToPath} from 'node:url';

const prefixPattern = /^[a-z][a-z0-9_]{0,31}$/;
const databasePattern = /^[a-zA-Z0-9_-]{1,48}$/;
export const CRASH_BOUNDARIES = Object.freeze([
    'after-apply-intent', 'before-apply-commit', 'after-apply-commit',
    'after-rollback-intent', 'before-rollback-commit', 'after-rollback-step', 'after-result',
]);
let activeEvidence = {pid: process.pid, node: process.version, trace: [], traceTruncated: false};

/** Keep the actual native cause chain bounded, including timeout labels and cleanup errors. */
export function serializeWorkerError(error, depth = 0, seen = new Set(), budget = {nodes: 12, bytes: 32768}) {
    if (depth >= 4 || --budget.nodes < 0 || budget.bytes <= 0) return {message: 'Error evidence limit reached', truncated: true};
    const text = (value, maximum) => {
        const limit = Math.max(0, budget.bytes);
        let selected = Buffer.from(String(value).slice(0, maximum)).subarray(0, limit).toString('utf8');
        while (Buffer.byteLength(selected) > limit) selected = selected.slice(0, -1);
        budget.bytes -= Buffer.byteLength(selected);
        return selected;
    };
    if (!error || typeof error !== 'object') return {message: text(error, 4096)};
    if (seen.has(error)) return {message: 'Circular error cause', truncated: true};
    seen.add(error);
    const code = typeof error.code === 'string' ? text(error.code, 256) : typeof error.code === 'number' ? error.code : null;
    const value = {name: text(error.name ?? 'Error', 256), message: text(error.message ?? error, 4096),
        code, retryable: error.retryable === true, stack: text(error.stack ?? '', 8192),
        labels: Array.isArray(error.errorLabels) ? error.errorLabels.slice(0, 16).map(label => text(label, 256)) : []};
    if (error.cause !== undefined) value.cause = serializeWorkerError(error.cause, depth + 1, seen, budget);
    if (error.cleanupError !== undefined) value.cleanupError = serializeWorkerError(error.cleanupError, depth + 1, seen, budget);
    if (Array.isArray(error.errors)) value.errors = error.errors.slice(0, 4).map(item => serializeWorkerError(item, depth + 1, seen, budget));
    return value;
}

/** The public runner creates the resources; this IPC child accepts only its loopback endpoint. */
export function validateWorkerJob(input) {
    if (!input || input.schemaVersion !== 1 || !['process', 'rollback', 'inspect'].includes(input.action)
        || typeof input.databaseName !== 'string' || !databasePattern.test(input.databaseName)
        || typeof input.collectionPrefix !== 'string' || !prefixPattern.test(input.collectionPrefix)
        || typeof input.backendId !== 'string' || input.backendId.length === 0 || input.backendId.length > 256
        || !input.definition || !input.binding
        || (input.crash !== undefined && !CRASH_BOUNDARIES.includes(input.crash)))
        throw new Error('Invalid bounded rollback fixture job');
    const endpoint = new URL(input.uri);
    if (endpoint.protocol !== 'mongodb:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password
        || !/^[0-9]+$/.test(endpoint.port) || Number(endpoint.port) <= 1024 || Number(endpoint.port) === 27017
        || Number(endpoint.port) > 65535 || !['', '/'].includes(endpoint.pathname)
        || endpoint.hash || [...endpoint.searchParams.keys()].some(key => !['directConnection', 'replicaSet'].includes(key)
            || endpoint.searchParams.getAll(key).length !== 1)
        || (endpoint.searchParams.has('directConnection') && endpoint.searchParams.get('directConnection') !== 'true')
        || (endpoint.searchParams.has('replicaSet') && !/^[A-Za-z0-9_-]{1,64}$/.test(endpoint.searchParams.get('replicaSet'))))
        throw new Error('Rollback fixture child requires an owned loopback MongoDB endpoint');
    if (input.adapterOptions !== undefined && (!input.adapterOptions || typeof input.adapterOptions !== 'object'
        || Array.isArray(input.adapterOptions) || Object.entries(input.adapterOptions).some(([name, value]) =>
            !['receiptRetention', 'rollbackRetentionBlocks', 'rollbackRetentionBytes', 'rollbackMaxBlockBytes'].includes(name)
            || !Number.isSafeInteger(value) || value < 1)))
        throw new Error('Only bounded fixture retention overrides are accepted');
    if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024)
        throw new Error('Rollback fixture job exceeds its IPC byte budget');
    return input;
}

/** Classify natural durable writes, never arbitrary updates or another projection database. */
export function classifyMongoCommand(event, databaseName, collectionPrefix) {
    const command = event?.command;
    if (event?.databaseName !== databaseName || !command) return undefined;
    const metadata = `${collectionPrefix}_metadata`;
    if (event.commandName === 'findAndModify' && command.findAndModify === metadata) {
        const set = command.update?.$set;
        if (set?.rollback && typeof set.revision === 'string') return 'rollback-intent';
        if (set?.pending && typeof set.pending.digest === 'string') return 'apply-intent';
    }
    if (event.commandName === 'update' && command.update === metadata && Array.isArray(command.updates)) {
        for (const update of command.updates) {
            const set = update.u?.$set;
            if (set?.checkpoint && Array.isArray(set.undo))
                return set.rollback?.status === 'running' || set.rollback?.status === 'complete' ? 'rollback-step' : 'apply';
        }
    }
    return undefined;
}

export function matchesCrashBoundary(boundary, phase, stage) {
    return (boundary === 'after-apply-intent' && phase === 'apply-intent' && stage === 'succeeded')
        || (boundary === 'before-apply-commit' && phase === 'apply' && stage === 'commit-started')
        || (boundary === 'after-apply-commit' && phase === 'apply' && stage === 'commit-succeeded')
        || (boundary === 'after-rollback-intent' && phase === 'rollback-intent' && stage === 'succeeded')
        || (boundary === 'before-rollback-commit' && phase === 'rollback-step' && stage === 'commit-started')
        || (boundary === 'after-rollback-step' && phase === 'rollback-step' && stage === 'commit-succeeded');
}

async function runJob(raw) {
    const job = validateWorkerJob(raw);
    assertNativeQualificationRuntime();
    if (process.platform !== 'linux') throw new Error('Process-crash qualification requires native Linux Node.js 24 or 26');
    const {MongoClient} = await import('mongodb');
    const {createMongoDbRollbackAdapter} = await import('../../packages/backend-mongodb/dist/index.js');
    const {RecoverableProjectionRuntime} = await import('../../build/indexer/projection/recoverable-runtime.js');
    const client = new MongoClient(job.uri, {appName: 'h45-rollback-crash-child', monitorCommands: true,
        directConnection: true, retryWrites: false, maxPoolSize: 4, serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000, timeoutMS: 30_000});
    const trace = [], requests = new Map(), transactions = new Map();
    activeEvidence = {pid: process.pid, node: process.version, trace, traceTruncated: false};
    let armed = false, crashed = false;
    const appendTrace = item => {
        if (trace.length < 1000) trace.push(item);
        else activeEvidence.traceTruncated = true;
    };
    const transactionKey = command => command?.txnNumber === undefined ? undefined
        : `${command.lsid?.id?.toString('hex') ?? 'session'}:${command.txnNumber.toString()}`;
    const crash = (phase, details = {}) => {
        if (crashed) return;
        crashed = true;
        // Synchronous pipe write survives SIGKILL; an asynchronous IPC send can be lost at this boundary.
        writeSync(1, `${JSON.stringify({type: 'barrier', boundary: job.crash, phase, pid: process.pid,
            node: process.version, ...details, trace, traceTruncated: activeEvidence.traceTruncated})}\n`);
        process.kill(process.pid, 'SIGKILL');
    };
    client.on('commandStarted', event => {
        if (!armed) return;
        const key = transactionKey(event.command);
        const classified = classifyMongoCommand(event, job.databaseName, job.collectionPrefix);
        if (classified && key) transactions.set(key, classified);
        const scoped = event.databaseName === job.databaseName;
        if (!scoped && !(['commitTransaction', 'abortTransaction'].includes(event.commandName) && transactions.has(key))) return;
        if (scoped && key && !transactions.has(key)) transactions.set(key, 'storage-transaction');
        if (transactions.size > 128) transactions.delete(transactions.keys().next().value);
        const phase = classified ?? transactions.get(key) ?? 'storage';
        const item = {command: event.commandName, phase, stage: event.commandName === 'commitTransaction' ? 'commit-started' : 'started',
            requestId: event.requestId, transaction: key ?? null};
        requests.set(event.requestId, item);
        appendTrace(item);
        if (matchesCrashBoundary(job.crash, phase, item.stage)) crash(phase, {event: item});
    });
    client.on('commandSucceeded', event => {
        if (!armed) return;
        const request = requests.get(event.requestId);
        if (!request) return;
        requests.delete(event.requestId);
        const item = {...request, stage: event.commandName === 'commitTransaction' ? 'commit-succeeded' : 'succeeded',
            writeErrorCodes: event.reply?.writeErrors?.map(error => error.code) ?? [],
            writeConcernErrorCode: event.reply?.writeConcernError?.code ?? null};
        appendTrace(item);
        if (event.reply?.ok === 1 && item.writeErrorCodes.length === 0 && item.writeConcernErrorCode === null
            && matchesCrashBoundary(job.crash, item.phase, item.stage)) crash(item.phase, {event: item});
    });
    client.on('commandFailed', event => {
        const request = requests.get(event.requestId);
        if (!armed || !request) return;
        requests.delete(event.requestId);
        appendTrace({...request, stage: 'failed', failure: {
            name: String(event.failure?.name ?? 'Error').slice(0, 128),
            code: typeof event.failure?.code === 'number' ? event.failure.code : String(event.failure?.code ?? '').slice(0, 128),
            message: String(event.failure?.message ?? event.failure).slice(0, 1024),
        }});
    });
    let operationError;
    try {
        await client.connect();
        const adapter = createMongoDbRollbackAdapter({client, databaseName: job.databaseName, backendId: job.backendId,
            collectionPrefix: job.collectionPrefix, operationTimeoutMS: 30_000, transactionTimeoutMS: 60_000,
            ...job.adapterOptions});
        const runtime = await RecoverableProjectionRuntime.create({adapter, definition: job.definition, binding: job.binding,
            genesis: {blockNum: 0, blockId: '0'.repeat(64)}});
        armed = true;
        let result;
        if (job.action === 'process') result = await runtime.process(job.frame);
        else if (job.action === 'rollback') result = await runtime.rollback(job.request);
        else {
            const recovery = await runtime.recovery();
            let query;
            try {query = await runtime.query({filter: [], limit: 1000});}
            catch (error) {query = {error: error?.code ?? String(error)};}
            result = {recovery, query};
        }
        if (job.crash === 'after-result') crash('completed-operation', {completed: result});
        if (job.crash !== undefined) throw new Error(`Crash boundary ${job.crash} was not observed`);
        const recovery = await runtime.recovery();
        return {result, recovery, trace, traceTruncated: activeEvidence.traceTruncated, pid: process.pid, node: process.version};
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        try {await client.close();}
        catch (error) {if (operationError) operationError.cleanupError = error; else throw error;}
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    if (process.argv.length !== 3 || process.argv[2] !== '--ipc-worker' || typeof process.send !== 'function')
        throw new Error('This qualification worker accepts only the owned runner IPC protocol');
    let finished = false;
    process.once('disconnect', () => {if (!finished) process.kill(process.pid, 'SIGKILL');});
    process.once('message', async message => {
        let envelope;
        try {envelope = {type: 'result', value: await runJob(message)};}
        catch (error) {envelope = {type: 'error', error: serializeWorkerError(error), evidence: activeEvidence}; process.exitCode = 1;}
        process.send(envelope, error => {
            if (error) process.exitCode = 1;
            finished = true;
            process.disconnect();
        });
    });
}
